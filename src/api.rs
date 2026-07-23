use std::{
    net::SocketAddr,
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    Json, Router,
    extract::{
        ConnectInfo, DefaultBodyLimit, Path, Query, State,
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, HeaderValue, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::{any, get, patch, post},
};
use axum_extra::extract::{
    CookieJar,
    cookie::{Cookie, SameSite},
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use time::Duration;
use tokio::sync::broadcast;
use tower_http::{
    catch_panic::CatchPanicLayer,
    compression::CompressionLayer,
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
    trace::TraceLayer,
};
use uuid::Uuid;

use crate::{
    ai::{PiClientConfig, PiService, UpdatePiSettings},
    artifacts,
    auth::{AuthError, AuthService, LoginLimiter},
    files::{self, FileError},
    terminal::{
        CreateTerminal, RenameTerminal, TerminalError, TerminalEvent, TerminalManager,
        TerminalSession,
    },
};

const SESSION_COOKIE: &str = "term_server_session";

#[derive(Clone)]
pub struct AppState {
    pub auth: AuthService,
    pub terminals: Arc<TerminalManager>,
    pub pi: Arc<PiService>,
    pub login_limiter: Arc<LoginLimiter>,
    pub allowed_origins: Arc<[String]>,
    pub secure: bool,
    pub secure_cookie: bool,
    pub scrollback_lines: u32,
    pub max_panes: u8,
    pub hostname: String,
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

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ClientMessage {
    Input { data: String },
    Resize { cols: u16, rows: u16 },
    Ping,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ServerMessage<'a> {
    Ready {
        terminal: Box<crate::terminal::TerminalInfo>,
    },
    Exit {
        #[serde(rename = "exitCode")]
        exit_code: u32,
    },
    Pong,
    Error {
        message: &'a str,
    },
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
        pi: state.pi.client_config(),
    }))
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
        .pi
        .update(body)
        .map(Json)
        .map_err(ApiError::BadRequest)
}

async fn list_terminals(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<Json<Vec<crate::terminal::TerminalInfo>>, ApiError> {
    require_auth(&jar, &state)?;
    Ok(Json(state.terminals.list()))
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
    let terminals = state.terminals.clone();
    let terminal = tokio::task::spawn_blocking(move || terminals.create(body))
        .await
        .map_err(|error| {
            tracing::error!(%error, "terminal creation task failed");
            ApiError::Internal
        })??;
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
        .terminals
        .rename(id, &body.path)?
        .map(Json)
        .ok_or(ApiError::NotFound)
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
    state
        .terminals
        .remove(id)
        .then_some(StatusCode::NO_CONTENT)
        .ok_or(ApiError::NotFound)
}

async fn terminal_processes(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    jar: CookieJar,
) -> Result<Json<crate::terminal::ProcessInspectorSnapshot>, ApiError> {
    require_auth(&jar, &state)?;
    state
        .terminals
        .get(id)
        .map(|terminal| Json(terminal.process_inspector()))
        .ok_or(ApiError::NotFound)
}

async fn list_artifacts(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<Json<Vec<artifacts::ArtifactEntry>>, ApiError> {
    require_auth(&jar, &state)?;
    let session_ids = state
        .terminals
        .list()
        .into_iter()
        .map(|terminal| terminal.id)
        .collect::<Vec<_>>();
    let entries = tokio::task::spawn_blocking(move || artifacts::list_for_sessions(&session_ids))
        .await
        .map_err(|error| {
            tracing::error!(%error, "artifact listing task failed");
            ApiError::Internal
        })?;
    Ok(Json(entries))
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

async fn raw_file(
    State(state): State<AppState>,
    Query(query): Query<FilePathQuery>,
    jar: CookieJar,
) -> Result<Response, ApiError> {
    require_auth(&jar, &state)?;
    let image =
        tokio::task::spawn_blocking(move || files::read_image(&query.path, query.cwd.as_deref()))
            .await
            .map_err(|error| {
                tracing::error!(%error, "image read task failed");
                ApiError::Internal
            })??;
    let content_type = HeaderValue::from_str(&image.mime).map_err(|_| ApiError::Internal)?;
    let mut response = image.bytes.into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, content_type);
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    Ok(response)
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
    let terminal = state.terminals.get(id).ok_or(ApiError::NotFound)?;
    Ok(websocket
        .max_message_size(64 * 1024)
        .max_frame_size(64 * 1024)
        .write_buffer_size(128 * 1024)
        .max_write_buffer_size(4 * 1024 * 1024)
        .on_upgrade(move |socket| handle_terminal_socket(socket, terminal)))
}

struct Attachment(Arc<TerminalSession>);

impl Drop for Attachment {
    fn drop(&mut self) {
        self.0.detach();
    }
}

async fn handle_terminal_socket(mut socket: WebSocket, terminal: Arc<TerminalSession>) {
    terminal.attach();
    let _attachment = Attachment(terminal.clone());
    let (mut events, replay) = terminal.subscribe();
    let ready = serde_json::to_string(&ServerMessage::Ready {
        terminal: Box::new(terminal.info()),
    })
    .expect("serializable terminal");
    if socket.send(Message::Text(ready.into())).await.is_err() {
        return;
    }
    for chunk in replay {
        if socket.send(Message::Binary(chunk)).await.is_err() {
            return;
        }
    }

    let (mut sender, mut receiver) = socket.split();
    loop {
        tokio::select! {
            event = events.recv() => {
                match event {
                    Ok(TerminalEvent::Output(chunk)) => {
                        if sender.send(Message::Binary(chunk)).await.is_err() { break; }
                    }
                    Ok(TerminalEvent::Exit(exit_code)) => {
                        let message = serde_json::to_string(&ServerMessage::Exit { exit_code }).expect("serializable exit");
                        let _ = sender.send(Message::Text(message.into())).await;
                        break;
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let _ = sender.send(Message::Close(Some(CloseFrame {
                            code: 1013,
                            reason: "terminal client fell behind".into(),
                        }))).await;
                        break;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            incoming = receiver.next() => {
                let Some(Ok(message)) = incoming else { break; };
                match message {
                    Message::Text(text) => match serde_json::from_str::<ClientMessage>(&text) {
                        Ok(ClientMessage::Input { data }) if data.len() <= 64 * 1024 => {
                            if let Err(error) = terminal.write(data.as_bytes()) {
                                tracing::debug!(%error, "terminal input failed");
                                break;
                            }
                        }
                        Ok(ClientMessage::Resize { cols, rows }) => {
                            if terminal.resize(cols, rows).is_err() { break; }
                        }
                        Ok(ClientMessage::Ping) => {
                            let pong = serde_json::to_string(&ServerMessage::Pong).expect("serializable pong");
                            if sender.send(Message::Text(pong.into())).await.is_err() { break; }
                        }
                        _ => {
                            let error = serde_json::to_string(&ServerMessage::Error { message: "invalid terminal message" })
                                .expect("serializable error");
                            if sender.send(Message::Text(error.into())).await.is_err() { break; }
                        }
                    },
                    Message::Close(_) => break,
                    Message::Ping(payload) => {
                        if sender.send(Message::Pong(payload)).await.is_err() { break; }
                    }
                    _ => {}
                }
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
        .route("/terminals", get(list_terminals).post(create_terminal))
        .route(
            "/terminals/{id}",
            patch(rename_terminal).delete(remove_terminal),
        )
        .route("/terminals/{id}/processes", get(terminal_processes))
        .route("/terminals/{id}/socket", any(terminal_socket))
        .route("/artifacts", get(list_artifacts))
        .route("/files/meta", get(file_metadata))
        .route("/files/list", get(list_files))
        .route("/files/search", get(search_files))
        .route("/files/content", get(read_file).put(save_file))
        .route("/files/raw", get(raw_file))
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
    use crate::auth::load_auth;

    async fn test_state() -> AppState {
        let directory = tempfile::tempdir().unwrap();
        load_auth(directory.path(), Some("testing-password".into()), None)
            .await
            .unwrap();
        let auth = load_auth(directory.path(), None, None)
            .await
            .unwrap()
            .service;
        AppState {
            auth,
            terminals: Arc::new(TerminalManager::new(Some("/bin/sh".into()), 1024 * 1024)),
            pi: Arc::new(PiService::new(directory.path())),
            login_limiter: Arc::new(LoginLimiter::default()),
            allowed_origins: Arc::from([]),
            secure: false,
            secure_cookie: false,
            scrollback_lines: 200_000,
            max_panes: 4,
            hostname: "test-machine".to_string(),
        }
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
