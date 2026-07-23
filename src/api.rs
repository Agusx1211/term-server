use std::{
    net::SocketAddr,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    Json, Router,
    body::Body,
    extract::{ConnectInfo, DefaultBodyLimit, Path, Query, Request, State, ws::WebSocketUpgrade},
    http::{HeaderMap, HeaderValue, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::{any, get, patch, post},
};
use axum_extra::extract::{
    CookieJar,
    cookie::{Cookie, SameSite},
};
use axum_server::Handle;
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use time::Duration;
use tower_http::{
    catch_panic::CatchPanicLayer,
    compression::CompressionLayer,
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
    trace::TraceLayer,
};
use uuid::Uuid;

#[cfg(unix)]
use crate::broker::BrokerWebSocket;
use crate::{
    ai::{PiClientConfig, UpdatePiSettings},
    auth::{AuthError, AuthService, LoginLimiter},
    build,
    files::{self, FileError},
    terminal::{CreateTerminal, RenameTerminal, TerminalError},
    update::{UpdateConfig, UpdateError, UpdateService, UpdateStatus},
    workspace::{SessionConnection, WorkspaceBackend, WorkspaceError, serve_terminal_socket},
};
#[cfg(unix)]
use axum::extract::ws::{Message, WebSocket};
#[cfg(unix)]
use futures_util::{SinkExt, StreamExt};

const SESSION_COOKIE: &str = "term_server_session";

#[derive(Clone)]
pub struct AppState {
    pub auth: AuthService,
    pub workspace: WorkspaceBackend,
    pub login_limiter: Arc<LoginLimiter>,
    pub allowed_origins: Arc<[String]>,
    pub secure: bool,
    pub secure_cookie: bool,
    pub scrollback_lines: u32,
    pub max_panes: u8,
    pub hostname: String,
    pub updates: Arc<UpdateService>,
    pub server_control: ServerControl,
}

#[derive(Clone)]
pub struct ServerControl {
    handle: Handle<SocketAddr>,
    restart_requested: Arc<AtomicBool>,
}

impl ServerControl {
    pub fn new(handle: Handle<SocketAddr>) -> Self {
        Self {
            handle,
            restart_requested: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn shutdown(&self, restart: bool) {
        if restart {
            self.restart_requested.store(true, Ordering::SeqCst);
        }
        self.handle
            .graceful_shutdown(Some(std::time::Duration::from_secs(5)));
    }

    pub fn restart_requested(&self) -> bool {
        self.restart_requested.load(Ordering::SeqCst)
    }
}

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("authentication required")]
    Unauthorized,
    #[error("invalid password")]
    InvalidLogin,
    #[error("origin is not allowed")]
    ForbiddenOrigin,
    #[error("terminal not found")]
    NotFound,
    #[error("file or directory not found")]
    FileNotFound,
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    PayloadTooLarge(String),
    #[error("{0}")]
    BadGateway(String),
    #[error("too many login attempts; try again in {0} seconds")]
    RateLimited(u64),
    #[error("internal server error")]
    Internal,
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, retry_after) = match self {
            Self::Unauthorized | Self::InvalidLogin => (StatusCode::UNAUTHORIZED, None),
            Self::ForbiddenOrigin => (StatusCode::FORBIDDEN, None),
            Self::NotFound | Self::FileNotFound => (StatusCode::NOT_FOUND, None),
            Self::BadRequest(_) => (StatusCode::BAD_REQUEST, None),
            Self::Conflict(_) => (StatusCode::CONFLICT, None),
            Self::PayloadTooLarge(_) => (StatusCode::PAYLOAD_TOO_LARGE, None),
            Self::BadGateway(_) => (StatusCode::BAD_GATEWAY, None),
            Self::RateLimited(seconds) => (StatusCode::TOO_MANY_REQUESTS, Some(seconds)),
            Self::Internal => (StatusCode::INTERNAL_SERVER_ERROR, None),
        };
        let message = self.to_string();
        let mut response = (status, Json(ErrorBody { error: message })).into_response();
        if let Some(seconds) = retry_after
            && let Ok(value) = HeaderValue::from_str(&seconds.to_string())
        {
            response.headers_mut().insert(header::RETRY_AFTER, value);
        }
        response
    }
}

impl From<TerminalError> for ApiError {
    fn from(error: TerminalError) -> Self {
        Self::BadRequest(error.to_string())
    }
}

impl From<WorkspaceError> for ApiError {
    fn from(error: WorkspaceError) -> Self {
        match error.status() {
            Some(StatusCode::NOT_FOUND) => Self::NotFound,
            Some(StatusCode::BAD_REQUEST) => Self::BadRequest(error.to_string()),
            Some(StatusCode::CONFLICT) => Self::Conflict(error.to_string()),
            _ => Self::BadGateway(error.to_string()),
        }
    }
}

impl From<AuthError> for ApiError {
    fn from(_error: AuthError) -> Self {
        Self::Internal
    }
}

impl From<FileError> for ApiError {
    fn from(error: FileError) -> Self {
        let message = error.to_string();
        match error {
            FileError::NotFound => Self::FileNotFound,
            FileError::Conflict => Self::Conflict(message),
            FileError::TooLarge => Self::PayloadTooLarge(message),
            FileError::Io(_) => Self::Internal,
            _ => Self::BadRequest(message),
        }
    }
}

impl From<UpdateError> for ApiError {
    fn from(error: UpdateError) -> Self {
        match error {
            UpdateError::Unsupported(_)
            | UpdateError::Busy
            | UpdateError::Stale
            | UpdateError::AlreadyCurrent => Self::Conflict(error.to_string()),
            _ => Self::BadGateway(error.to_string()),
        }
    }
}

#[derive(Debug, Deserialize)]
struct LoginRequest {
    password: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangePasswordRequest {
    current_password: String,
    new_password: String,
}

#[derive(Serialize)]
struct SessionResponse {
    authenticated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientConfig {
    scrollback_lines: u32,
    max_panes: u8,
    secure: bool,
    hostname: String,
    password_managed_externally: bool,
    pi: PiClientConfig,
    build: build::BuildInfo,
    updates: UpdateConfig,
}

#[derive(Debug, Deserialize)]
struct InstallUpdateRequest {
    commit: String,
}

#[derive(Debug, Deserialize)]
struct FilePathQuery {
    path: String,
    cwd: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FileSearchQuery {
    root: String,
    cwd: Option<String>,
    query: String,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveFileRequest {
    path: String,
    cwd: Option<String>,
    content: String,
    version: String,
}

fn authenticated(jar: &CookieJar, state: &AppState) -> bool {
    state
        .auth
        .verify_session(jar.get(SESSION_COOKIE).map(Cookie::value))
}

fn require_auth(jar: &CookieJar, state: &AppState) -> Result<(), ApiError> {
    authenticated(jar, state)
        .then_some(())
        .ok_or(ApiError::Unauthorized)
}

fn session_cookie(state: &AppState) -> Cookie<'static> {
    Cookie::build((SESSION_COOKIE, state.auth.create_session()))
        .path("/")
        .http_only(true)
        .secure(state.secure || state.secure_cookie)
        .same_site(SameSite::Strict)
        .max_age(Duration::days(7))
        .build()
}

fn require_origin(headers: &HeaderMap, uri: &Uri, state: &AppState) -> Result<(), ApiError> {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return Ok(());
    };
    let origin = origin
        .to_str()
        .map_err(|_| ApiError::ForbiddenOrigin)?
        .trim_end_matches('/');
    if state
        .allowed_origins
        .iter()
        .any(|allowed| allowed.trim_end_matches('/') == origin)
    {
        return Ok(());
    }
    let authority = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .or_else(|| uri.authority().map(|authority| authority.as_str()))
        .ok_or(ApiError::ForbiddenOrigin)?;
    let scheme = if state.secure { "https" } else { "http" };
    (origin == format!("{scheme}://{authority}"))
        .then_some(())
        .ok_or(ApiError::ForbiddenOrigin)
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}

async fn session(State(state): State<AppState>, jar: CookieJar) -> Json<SessionResponse> {
    Json(SessionResponse {
        authenticated: authenticated(&jar, &state),
    })
}

async fn login(
    State(state): State<AppState>,
    ConnectInfo(client_address): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
    jar: CookieJar,
    Json(body): Json<LoginRequest>,
) -> Result<(CookieJar, Json<serde_json::Value>), ApiError> {
    require_origin(&headers, &uri, &state)?;
    if body.password.len() > 4096 {
        return Err(ApiError::BadRequest("password is too long".to_owned()));
    }
    let client = client_address.ip().to_string();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    state
        .login_limiter
        .consume(&client, now)
        .map_err(ApiError::RateLimited)?;
    if !state.auth.verify_password(body.password).await? {
        return Err(ApiError::InvalidLogin);
    }
    state.login_limiter.reset(&client);

    Ok((
        jar.add(session_cookie(&state)),
        Json(serde_json::json!({ "ok": true })),
    ))
}

async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    jar: CookieJar,
) -> Result<(CookieJar, Json<serde_json::Value>), ApiError> {
    require_origin(&headers, &uri, &state)?;
    require_auth(&jar, &state)?;
    let removal = Cookie::build((SESSION_COOKIE, ""))
        .path("/")
        .http_only(true)
        .secure(state.secure || state.secure_cookie)
        .same_site(SameSite::Strict)
        .max_age(Duration::ZERO)
        .build();
    Ok((jar.remove(removal), Json(serde_json::json!({ "ok": true }))))
}

async fn change_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    jar: CookieJar,
    Json(body): Json<ChangePasswordRequest>,
) -> Result<(CookieJar, Json<serde_json::Value>), ApiError> {
    require_origin(&headers, &uri, &state)?;
    require_auth(&jar, &state)?;
    if body.current_password.len() > 4096 || body.new_password.len() > 4096 {
        return Err(ApiError::BadRequest("password is too long".to_owned()));
    }

    let changed = state
        .auth
        .change_password(body.current_password, body.new_password)
        .await
        .map_err(|error| match error {
            error @ AuthError::ShortPassword => ApiError::BadRequest(error.to_string()),
            error @ AuthError::ExternallyManaged => ApiError::Conflict(error.to_string()),
            _ => ApiError::Internal,
        })?;
    if !changed {
        return Err(ApiError::InvalidLogin);
    }

    Ok((
        jar.add(session_cookie(&state)),
        Json(serde_json::json!({ "ok": true })),
    ))
}

async fn config(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<Json<ClientConfig>, ApiError> {
    require_auth(&jar, &state)?;
    Ok(Json(ClientConfig {
        scrollback_lines: state.scrollback_lines,
        max_panes: state.max_panes,
        secure: state.secure,
        hostname: state.hostname.clone(),
        password_managed_externally: state.auth.password_is_externally_managed(),
        pi: state.workspace.pi_config().await?,
        build: build::info(),
        updates: state.updates.config(),
    }))
}

async fn update_status(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<Json<UpdateStatus>, ApiError> {
    require_auth(&jar, &state)?;
    state.updates.check().await.map(Json).map_err(Into::into)
}

async fn install_update(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    jar: CookieJar,
    Json(body): Json<InstallUpdateRequest>,
) -> Result<Json<crate::update::ReleaseInfo>, ApiError> {
    require_origin(&headers, &uri, &state)?;
    require_auth(&jar, &state)?;
    let release = state.updates.install(&body.commit).await?;
    let control = state.server_control.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(750)).await;
        control.shutdown(true);
    });
    Ok(Json(release))
}

async fn update_pi_config(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    jar: CookieJar,
    Json(body): Json<UpdatePiSettings>,
) -> Result<Json<PiClientConfig>, ApiError> {
    require_origin(&headers, &uri, &state)?;
    require_auth(&jar, &state)?;
    state
        .workspace
        .update_pi(body)
        .await
        .map(Json)
        .map_err(Into::into)
}

async fn list_terminals(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<Json<Vec<crate::terminal::TerminalInfo>>, ApiError> {
    require_auth(&jar, &state)?;
    state.workspace.list().await.map(Json).map_err(Into::into)
}

async fn create_terminal(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    jar: CookieJar,
    Json(body): Json<CreateTerminal>,
) -> Result<(StatusCode, Json<crate::terminal::TerminalInfo>), ApiError> {
    require_origin(&headers, &uri, &state)?;
    require_auth(&jar, &state)?;
    let terminal = state.workspace.create(body).await?;
    Ok((StatusCode::CREATED, Json(terminal)))
}

async fn rename_terminal(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    uri: Uri,
    jar: CookieJar,
    Json(body): Json<RenameTerminal>,
) -> Result<Json<crate::terminal::TerminalInfo>, ApiError> {
    require_origin(&headers, &uri, &state)?;
    require_auth(&jar, &state)?;
    state
        .workspace
        .rename(id, body)
        .await
        .map(Json)
        .map_err(Into::into)
}

async fn remove_terminal(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    uri: Uri,
    jar: CookieJar,
) -> Result<StatusCode, ApiError> {
    require_origin(&headers, &uri, &state)?;
    require_auth(&jar, &state)?;
    state.workspace.remove(id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn terminal_processes(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    jar: CookieJar,
) -> Result<Json<crate::terminal::ProcessInspectorSnapshot>, ApiError> {
    require_auth(&jar, &state)?;
    state
        .workspace
        .process_inspector(id)
        .await
        .map(Json)
        .map_err(Into::into)
}

async fn file_metadata(
    State(state): State<AppState>,
    Query(query): Query<FilePathQuery>,
    jar: CookieJar,
) -> Result<Json<files::FileEntry>, ApiError> {
    require_auth(&jar, &state)?;
    let metadata =
        tokio::task::spawn_blocking(move || files::metadata(&query.path, query.cwd.as_deref()))
            .await
            .map_err(|error| {
                tracing::error!(%error, "file metadata task failed");
                ApiError::Internal
            })??;
    Ok(Json(metadata))
}

async fn list_files(
    State(state): State<AppState>,
    Query(query): Query<FilePathQuery>,
    jar: CookieJar,
) -> Result<Json<files::DirectoryListing>, ApiError> {
    require_auth(&jar, &state)?;
    let listing = tokio::task::spawn_blocking(move || {
        files::list_directory(&query.path, query.cwd.as_deref())
    })
    .await
    .map_err(|error| {
        tracing::error!(%error, "directory listing task failed");
        ApiError::Internal
    })??;
    Ok(Json(listing))
}

async fn search_files(
    State(state): State<AppState>,
    Query(query): Query<FileSearchQuery>,
    jar: CookieJar,
) -> Result<Json<files::FileSearchResults>, ApiError> {
    require_auth(&jar, &state)?;
    let results = tokio::task::spawn_blocking(move || {
        files::search(&query.root, query.cwd.as_deref(), &query.query, query.limit)
    })
    .await
    .map_err(|error| {
        tracing::error!(%error, "file search task failed");
        ApiError::Internal
    })??;
    Ok(Json(results))
}

async fn read_file(
    State(state): State<AppState>,
    Query(query): Query<FilePathQuery>,
    jar: CookieJar,
) -> Result<Json<files::FileDocument>, ApiError> {
    require_auth(&jar, &state)?;
    let document = tokio::task::spawn_blocking(move || {
        files::read_document(&query.path, query.cwd.as_deref())
    })
    .await
    .map_err(|error| {
        tracing::error!(%error, "file read task failed");
        ApiError::Internal
    })??;
    Ok(Json(document))
}

async fn preview_file(
    State(state): State<AppState>,
    Query(query): Query<FilePathQuery>,
    jar: CookieJar,
    request: Request,
) -> Result<Response, ApiError> {
    require_auth(&jar, &state)?;
    stream_file(query, request, false).await
}

async fn download_file(
    State(state): State<AppState>,
    Query(query): Query<FilePathQuery>,
    jar: CookieJar,
    request: Request,
) -> Result<Response, ApiError> {
    require_auth(&jar, &state)?;
    stream_file(query, request, true).await
}

async fn stream_file(
    query: FilePathQuery,
    request: Request,
    download: bool,
) -> Result<Response, ApiError> {
    let asset = tokio::task::spawn_blocking(move || {
        if download {
            files::file_asset(&query.path, query.cwd.as_deref())
        } else {
            files::preview_asset(&query.path, query.cwd.as_deref())
        }
    })
    .await
    .map_err(|error| {
        tracing::error!(%error, "file stream task failed");
        ApiError::Internal
    })??;

    let mut response = ServeFile::new(&asset.path)
        .try_call(request)
        .await
        .map_err(|error| {
            tracing::error!(%error, path = %asset.path.display(), "file stream failed");
            ApiError::Internal
        })?
        .map(Body::new);
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&asset.mime).map_err(|_| ApiError::Internal)?,
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        content_disposition(if download { "attachment" } else { "inline" }, &asset.name)?,
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    if !download && asset.mime == "application/pdf" {
        response.headers_mut().insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("frame-ancestors 'self'"),
        );
    }
    Ok(response)
}

fn content_disposition(kind: &str, name: &str) -> Result<HeaderValue, ApiError> {
    let fallback = name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    let fallback = if fallback.is_empty() {
        "download"
    } else {
        &fallback
    };
    HeaderValue::from_str(&format!(
        "{kind}; filename=\"{fallback}\"; filename*=UTF-8''{}",
        utf8_percent_encode(name, NON_ALPHANUMERIC)
    ))
    .map_err(|_| ApiError::Internal)
}

async fn save_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    jar: CookieJar,
    Json(body): Json<SaveFileRequest>,
) -> Result<Json<files::FileDocument>, ApiError> {
    require_origin(&headers, &uri, &state)?;
    require_auth(&jar, &state)?;
    let document = tokio::task::spawn_blocking(move || {
        files::save_document(&body.path, body.cwd.as_deref(), body.content, &body.version)
    })
    .await
    .map_err(|error| {
        tracing::error!(%error, "file save task failed");
        ApiError::Internal
    })??;
    Ok(Json(document))
}

async fn terminal_socket(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    uri: Uri,
    jar: CookieJar,
    websocket: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    require_origin(&headers, &uri, &state)?;
    require_auth(&jar, &state)?;
    let terminal = state.workspace.connect_terminal(id).await?;
    Ok(websocket
        .max_message_size(64 * 1024)
        .max_frame_size(64 * 1024)
        .write_buffer_size(128 * 1024)
        .max_write_buffer_size(4 * 1024 * 1024)
        .on_upgrade(move |socket| async move {
            match terminal {
                SessionConnection::Local(terminal) => {
                    serve_terminal_socket(socket, terminal).await;
                }
                #[cfg(unix)]
                SessionConnection::Broker(broker) => {
                    proxy_terminal_socket(socket, *broker).await;
                }
            }
        }))
}

#[cfg(unix)]
async fn proxy_terminal_socket(socket: WebSocket, broker: BrokerWebSocket) {
    use tokio_tungstenite::tungstenite::Message as BrokerMessage;

    let (mut browser_sender, mut browser_receiver) = socket.split();
    let (mut broker_sender, mut broker_receiver) = broker.split();
    loop {
        tokio::select! {
            message = broker_receiver.next() => {
                let Some(Ok(message)) = message else { break; };
                let outgoing = match message {
                    BrokerMessage::Text(text) => Message::Text(text.to_string().into()),
                    BrokerMessage::Binary(bytes) => Message::Binary(bytes.to_vec().into()),
                    BrokerMessage::Close(_) => Message::Close(None),
                    BrokerMessage::Ping(payload) => {
                        if broker_sender.send(BrokerMessage::Pong(payload)).await.is_err() { break; }
                        continue;
                    }
                    BrokerMessage::Pong(_) | BrokerMessage::Frame(_) => continue,
                };
                if browser_sender.send(outgoing).await.is_err() { break; }
            }
            message = browser_receiver.next() => {
                let Some(Ok(message)) = message else { break; };
                let outgoing = match message {
                    Message::Text(text) => BrokerMessage::Text(text.to_string().into()),
                    Message::Binary(bytes) => BrokerMessage::Binary(bytes.to_vec().into()),
                    Message::Close(_) => BrokerMessage::Close(None),
                    Message::Ping(payload) => {
                        if browser_sender.send(Message::Pong(payload)).await.is_err() { break; }
                        continue;
                    }
                    Message::Pong(_) => continue,
                };
                if broker_sender.send(outgoing).await.is_err() { break; }
            }
        }
    }
}

async fn api_not_found() -> ApiError {
    ApiError::NotFound
}

pub fn build_router(state: AppState, client_directory: Option<PathBuf>) -> Router {
    let api = Router::new()
        .route("/session", get(session))
        .route("/login", post(login))
        .route("/logout", post(logout))
        .route("/password", patch(change_password))
        .route("/config", get(config))
        .route("/config/pi", patch(update_pi_config))
        .route("/update", get(update_status).post(install_update))
        .route("/terminals", get(list_terminals).post(create_terminal))
        .route(
            "/terminals/{id}",
            patch(rename_terminal).delete(remove_terminal),
        )
        .route("/terminals/{id}/processes", get(terminal_processes))
        .route("/terminals/{id}/socket", any(terminal_socket))
        .route("/files/meta", get(file_metadata))
        .route("/files/list", get(list_files))
        .route("/files/search", get(search_files))
        .route("/files/content", get(read_file).put(save_file))
        .route("/files/raw", get(preview_file))
        .route("/files/download", get(download_file))
        .fallback(api_not_found);
    let secure = state.secure;
    let mut router = Router::new()
        .route("/healthz", get(health))
        .nest("/api", api)
        .with_state(state);

    if let Some(directory) = client_directory {
        let index = directory.join("index.html");
        router = router.fallback_service(ServeDir::new(directory).fallback(ServeFile::new(index)));
    }

    router = router
        .layer(DefaultBodyLimit::max(files::MAX_REQUEST_BYTES))
        .layer(CatchPanicLayer::new())
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(
                "default-src 'self'; base-uri 'self'; connect-src 'self' ws: wss:; font-src 'self' data:; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
            ),
        ));

    if secure {
        router = router.layer(SetResponseHeaderLayer::if_not_present(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=31536000"),
        ));
    }
    router
}

#[cfg(test)]
mod tests {
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use tower::ServiceExt;

    use super::*;
    use crate::{ai::PiService, auth::load_auth, terminal::TerminalManager};

    async fn test_state() -> AppState {
        let directory = tempfile::tempdir().unwrap();
        load_auth(directory.path(), Some("testing-password".into()), None)
            .await
            .unwrap();
        let auth = load_auth(directory.path(), None, None)
            .await
            .unwrap()
            .service;
        let terminals = Arc::new(TerminalManager::new(Some("/bin/sh".into()), 1024 * 1024));
        let pi = Arc::new(PiService::new(directory.path()));
        AppState {
            auth,
            workspace: WorkspaceBackend::local(terminals, pi),
            login_limiter: Arc::new(LoginLimiter::default()),
            allowed_origins: Arc::from([]),
            secure: false,
            secure_cookie: false,
            scrollback_lines: 200_000,
            max_panes: 4,
            hostname: "test-machine".to_string(),
            updates: Arc::new(UpdateService::new(
                None,
                "main".to_owned(),
                "https://example.invalid/releases/download".to_owned(),
                true,
            )),
            server_control: ServerControl::new(Handle::new()),
        }
    }

    async fn authenticated_app() -> (Router, String) {
        let app = build_router(test_state().await, None);
        let login = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/login")
                    .header(header::CONTENT_TYPE, "application/json")
                    .extension(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 40000))))
                    .body(Body::from(r#"{"password":"testing-password"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let cookie = login
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        (app, cookie)
    }

    #[tokio::test]
    async fn protects_terminal_list() {
        let response = build_router(test_state().await, None)
            .oneshot(
                Request::builder()
                    .uri("/api/terminals")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn protects_update_checks() {
        let response = build_router(test_state().await, None)
            .oneshot(
                Request::builder()
                    .uri("/api/update")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn login_sets_a_hardened_cookie() {
        let response = build_router(test_state().await, None)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/login")
                    .header(header::CONTENT_TYPE, "application/json")
                    .extension(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 40000))))
                    .body(Body::from(r#"{"password":"testing-password"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let cookie = response
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("SameSite=Strict"));
    }

    #[tokio::test]
    async fn password_change_rotates_credentials_and_session_cookie() {
        let app = build_router(test_state().await, None);
        let login = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/login")
                    .header(header::CONTENT_TYPE, "application/json")
                    .extension(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 40000))))
                    .body(Body::from(r#"{"password":"testing-password"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let old_cookie = login
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/password")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::COOKIE, &old_cookie)
                    .body(Body::from(
                        r#"{"currentPassword":"testing-password","newPassword":"replacement-password"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let new_cookie = response
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        assert!(new_cookie.contains("HttpOnly"));
        assert!(new_cookie.contains("SameSite=Strict"));
        let new_cookie = new_cookie.split(';').next().unwrap().to_owned();

        let old_session = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/config")
                    .header(header::COOKIE, old_cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(old_session.status(), StatusCode::UNAUTHORIZED);

        let new_session = app
            .oneshot(
                Request::builder()
                    .uri("/api/config")
                    .header(header::COOKIE, new_cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(new_session.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn pdf_preview_supports_range_requests_inside_the_application() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("preview.pdf");
        std::fs::write(&path, b"%PDF-1.7\npreview content").unwrap();
        let (app, cookie) = authenticated_app().await;
        let encoded_path = utf8_percent_encode(path.to_str().unwrap(), NON_ALPHANUMERIC);

        let response = app
            .oneshot(
                Request::builder()
                    .uri(format!("/api/files/raw?path={encoded_path}"))
                    .header(header::COOKIE, cookie)
                    .header(header::RANGE, "bytes=0-7")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/pdf"
        );
        assert!(
            response
                .headers()
                .get(header::CONTENT_DISPOSITION)
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("inline;")
        );
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_SECURITY_POLICY)
                .unwrap(),
            "frame-ancestors 'self'"
        );
        let body = to_bytes(response.into_body(), 1024).await.unwrap();
        assert_eq!(&body[..], b"%PDF-1.7");
    }

    #[tokio::test]
    async fn file_download_uses_an_attachment_with_the_original_name() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("notes résumé.txt");
        std::fs::write(&path, b"download me").unwrap();
        let (app, cookie) = authenticated_app().await;
        let encoded_path = utf8_percent_encode(path.to_str().unwrap(), NON_ALPHANUMERIC);

        let response = app
            .oneshot(
                Request::builder()
                    .uri(format!("/api/files/download?path={encoded_path}"))
                    .header(header::COOKIE, cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let disposition = response
            .headers()
            .get(header::CONTENT_DISPOSITION)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(disposition.starts_with("attachment;"));
        assert!(disposition.contains("filename*=UTF-8''notes%20r%C3%A9sum%C3%A9%2Etxt"));
        let body = to_bytes(response.into_body(), 1024).await.unwrap();
        assert_eq!(&body[..], b"download me");
    }

    #[tokio::test]
    async fn unknown_api_route_is_json_404() {
        let response = build_router(test_state().await, None)
            .oneshot(
                Request::builder()
                    .uri("/api/missing")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = to_bytes(response.into_body(), 1024).await.unwrap();
        assert!(String::from_utf8_lossy(&body).contains("terminal not found"));
    }

    #[tokio::test]
    async fn static_application_receives_security_headers() {
        let directory = tempfile::tempdir().unwrap();
        tokio::fs::write(
            directory.path().join("index.html"),
            "<!doctype html><title>test</title>",
        )
        .await
        .unwrap();
        let response = build_router(test_state().await, Some(directory.path().to_path_buf()))
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            response
                .headers()
                .contains_key(header::CONTENT_SECURITY_POLICY)
        );
        assert_eq!(
            response
                .headers()
                .get(header::X_CONTENT_TYPE_OPTIONS)
                .unwrap(),
            "nosniff"
        );
    }

    #[tokio::test]
    async fn cross_origin_login_is_rejected() {
        let response = build_router(test_state().await, None)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/login")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::HOST, "localhost")
                    .header(header::ORIGIN, "https://attacker.example")
                    .extension(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 40000))))
                    .body(Body::from(r#"{"password":"testing-password"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn http2_authority_is_accepted_as_the_same_origin() {
        let response = build_router(test_state().await, None)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("http://192.168.1.20:8090/api/login")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::ORIGIN, "http://192.168.1.20:8090")
                    .extension(ConnectInfo(SocketAddr::from(([192, 168, 1, 10], 40000))))
                    .body(Body::from(r#"{"password":"testing-password"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
}
