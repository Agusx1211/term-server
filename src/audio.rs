use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::Path,
    process::Stdio,
    sync::{
        Arc, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use axum::extract::ws::{Message, WebSocket};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt, stream::SplitSink};
use parking_lot::Mutex as SyncMutex;
use serde::Deserialize;
use tempfile::TempDir;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::unix::pipe::{self, Receiver, Sender},
    process::{Child, Command},
    sync::{Mutex, broadcast, mpsc, oneshot, watch},
    task::JoinHandle,
};
use uuid::Uuid;

pub const AUDIO_SAMPLE_RATE: u32 = 48_000;
const AUDIO_CHANNELS: u8 = 1;
pub const AUDIO_FRAME_SAMPLES: usize = 960;
const AUDIO_FRAME_BYTES: usize = AUDIO_FRAME_SAMPLES * size_of::<i16>();
const AUDIO_JITTER_FRAMES: usize = 3;
const AUDIO_MAX_QUEUED_FRAMES: usize = 25;
const AUDIO_FRAME_DURATION: Duration = Duration::from_millis(20);
const VIRTUAL_MICROPHONE: &str = "Term Server Microphone";
const VIRTUAL_SPEAKER: &str = "Term Server Speaker";

#[derive(Clone, Debug)]
struct VirtualAudioStatus {
    available: bool,
    input_device: &'static str,
    output_device: &'static str,
    sample_rate: u32,
    channels: u8,
    frame_samples: usize,
    jitter_frames: usize,
    error: Option<String>,
}

impl VirtualAudioStatus {
    fn available() -> Self {
        Self {
            available: true,
            input_device: VIRTUAL_MICROPHONE,
            output_device: VIRTUAL_SPEAKER,
            sample_rate: AUDIO_SAMPLE_RATE,
            channels: AUDIO_CHANNELS,
            frame_samples: AUDIO_FRAME_SAMPLES,
            jitter_frames: AUDIO_JITTER_FRAMES,
            error: None,
        }
    }

    fn unavailable(error: impl Into<String>) -> Self {
        Self {
            available: false,
            input_device: VIRTUAL_MICROPHONE,
            output_device: VIRTUAL_SPEAKER,
            sample_rate: AUDIO_SAMPLE_RATE,
            channels: AUDIO_CHANNELS,
            frame_samples: AUDIO_FRAME_SAMPLES,
            jitter_frames: AUDIO_JITTER_FRAMES,
            error: Some(error.into()),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct AudioPeerCounts {
    input_peers: usize,
    output_peers: usize,
}

#[derive(Clone, Copy, Debug, Default)]
struct AudioPeerRoute {
    input: bool,
    output: bool,
}

#[derive(Default)]
struct AudioRoutes {
    peers: HashMap<Uuid, AudioPeerRoute>,
}

impl AudioRoutes {
    fn counts(&self) -> AudioPeerCounts {
        AudioPeerCounts {
            input_peers: self.peers.values().filter(|route| route.input).count(),
            output_peers: self.peers.values().filter(|route| route.output).count(),
        }
    }
}

#[derive(Clone)]
pub struct AudioHub {
    inner: Arc<AudioHubInner>,
}

struct AudioHubInner {
    status: watch::Sender<VirtualAudioStatus>,
    input: SyncMutex<Option<mpsc::Sender<InputFrame>>>,
    active_inputs: Arc<SyncMutex<HashSet<Uuid>>>,
    output: broadcast::Sender<Bytes>,
    routes: SyncMutex<AudioRoutes>,
    counts: watch::Sender<AudioPeerCounts>,
    runtime: Mutex<Option<AudioRuntime>>,
    initializes_runtime: bool,
    shutting_down: AtomicBool,
}

struct AudioRuntime {
    shutdown: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
}

struct InputFrame {
    peer: Uuid,
    data: Bytes,
}

impl AudioHub {
    pub async fn start() -> Self {
        let status = match PulseSetup::sweep_stale().await {
            Ok(()) => VirtualAudioStatus::available(),
            Err(error) => {
                tracing::warn!(%error, "virtual audio is unavailable");
                VirtualAudioStatus::unavailable(format!(
                    "PulseAudio/PipeWire virtual audio is unavailable: {}",
                    truncate_error(&error, 300)
                ))
            }
        };
        Self::new(status, true)
    }

    fn new(status: VirtualAudioStatus, initializes_runtime: bool) -> Self {
        let (status, _) = watch::channel(status);
        let (output, _) = broadcast::channel(32);
        let (counts, _) = watch::channel(AudioPeerCounts::default());
        Self {
            inner: Arc::new(AudioHubInner {
                status,
                input: SyncMutex::new(None),
                active_inputs: Arc::new(SyncMutex::new(HashSet::new())),
                output,
                routes: SyncMutex::new(AudioRoutes::default()),
                counts,
                runtime: Mutex::new(None),
                initializes_runtime,
                shutting_down: AtomicBool::new(false),
            }),
        }
    }

    #[cfg(test)]
    pub fn test_available() -> Self {
        Self::new(VirtualAudioStatus::available(), false)
    }

    fn status(&self) -> VirtualAudioStatus {
        self.inner.status.borrow().clone()
    }

    fn status_receiver(&self) -> watch::Receiver<VirtualAudioStatus> {
        self.inner.status.subscribe()
    }

    fn attach(&self) -> AudioPeer {
        let id = Uuid::new_v4();
        self.inner
            .routes
            .lock()
            .peers
            .insert(id, AudioPeerRoute::default());
        AudioPeer {
            id,
            hub: self.clone(),
            input_enabled: false,
            output_enabled: false,
        }
    }

    fn counts(&self) -> AudioPeerCounts {
        self.inner.routes.lock().counts()
    }

    fn counts_receiver(&self) -> watch::Receiver<AudioPeerCounts> {
        self.inner.counts.subscribe()
    }

    fn output_receiver(&self) -> broadcast::Receiver<Bytes> {
        self.inner.output.subscribe()
    }

    async fn ensure_started(&self) -> Result<(), String> {
        let status_error = || {
            self.status()
                .error
                .unwrap_or_else(|| "virtual audio is unavailable".to_owned())
        };
        if !self.status().available {
            return Err(status_error());
        }
        if !self.inner.initializes_runtime {
            return Ok(());
        }
        if self.inner.shutting_down.load(Ordering::Acquire) {
            return Err("virtual audio is shutting down".to_owned());
        }

        let mut runtime = self.inner.runtime.lock().await;
        if runtime.is_some() {
            return if self.status().available {
                Ok(())
            } else {
                Err(status_error())
            };
        }

        let (pulse, input_pipe, output_pipe, keepalive) = match PulseSetup::start().await {
            Ok(setup) => setup,
            Err(error) => {
                let message = format!(
                    "PulseAudio/PipeWire virtual audio is unavailable: {}",
                    truncate_error(&error, 300)
                );
                self.inner
                    .status
                    .send_replace(VirtualAudioStatus::unavailable(message.clone()));
                return Err(message);
            }
        };
        let (input, input_receiver) = mpsc::channel(256);
        *self.inner.input.lock() = Some(input);
        let input_active = self.inner.active_inputs.clone();
        let input_task = tokio::spawn(run_input_pipe(input_pipe, input_receiver, input_active));
        let output_task = tokio::spawn(run_output_pipe(output_pipe, self.inner.output.clone()));
        let (shutdown, shutdown_receiver) = oneshot::channel();
        let task = tokio::spawn(monitor_audio_runtime(
            Arc::downgrade(&self.inner),
            pulse,
            keepalive,
            input_task,
            output_task,
            shutdown_receiver,
        ));
        *runtime = Some(AudioRuntime {
            shutdown: Some(shutdown),
            task,
        });
        tracing::info!(
            input_device = VIRTUAL_MICROPHONE,
            output_device = VIRTUAL_SPEAKER,
            "virtual audio devices are ready"
        );
        Ok(())
    }

    async fn set_route(
        &self,
        peer: Uuid,
        input: Option<bool>,
        output: Option<bool>,
    ) -> Result<(), String> {
        if input == Some(true) || output == Some(true) {
            self.ensure_started().await?;
        }
        let mut routes = self.inner.routes.lock();
        if (input == Some(true) || output == Some(true)) && !self.inner.status.borrow().available {
            return Err(self
                .inner
                .status
                .borrow()
                .error
                .clone()
                .unwrap_or_else(|| "virtual audio is unavailable".to_owned()));
        }
        let Some(route) = routes.peers.get_mut(&peer) else {
            return Err("audio connection is closed".to_owned());
        };
        if let Some(enabled) = input {
            route.input = enabled;
            let mut active = self.inner.active_inputs.lock();
            if enabled {
                active.insert(peer);
            } else {
                active.remove(&peer);
            }
        }
        if let Some(enabled) = output {
            route.output = enabled;
        }
        let counts = routes.counts();
        self.inner.counts.send_replace(counts);
        Ok(())
    }

    fn push_input(&self, peer: Uuid, data: Bytes) {
        if data.len() != AUDIO_FRAME_BYTES {
            return;
        }
        let input = self.inner.input.lock();
        let Some(sender) = input.as_ref() else {
            return;
        };
        let _ = sender.try_send(InputFrame { peer, data });
    }

    fn detach(&self, peer: Uuid) {
        let mut routes = self.inner.routes.lock();
        let removed = routes.peers.remove(&peer);
        if removed.is_some() {
            self.inner.active_inputs.lock().remove(&peer);
        }
        let counts = routes.counts();
        self.inner.counts.send_replace(counts);
    }

    pub async fn shutdown(&self) {
        self.inner.shutting_down.store(true, Ordering::Release);
        let Some(mut runtime) = self.inner.runtime.lock().await.take() else {
            return;
        };
        if let Some(shutdown) = runtime.shutdown.take() {
            let _ = shutdown.send(());
        }
        let _ = runtime.task.await;
        self.inner.input.lock().take();
    }
}

async fn monitor_audio_runtime(
    inner: Weak<AudioHubInner>,
    pulse: PulseSetup,
    mut keepalive: Child,
    mut input_task: JoinHandle<std::io::Result<()>>,
    mut output_task: JoinHandle<std::io::Result<()>>,
    mut shutdown: oneshot::Receiver<()>,
) {
    let (failure, input_finished, output_finished) = tokio::select! {
        _ = &mut shutdown => (None, false, false),
        result = keepalive.wait() => (Some(match result {
            Ok(status) => format!("virtual microphone keepalive stopped ({status})"),
            Err(error) => format!("could not monitor virtual microphone keepalive: {error}"),
        }), false, false),
        result = &mut input_task => (Some(worker_failure("microphone", result)), true, false),
        result = &mut output_task => (Some(worker_failure("speaker", result)), false, true),
    };

    if let Some(error) = failure {
        tracing::warn!(%error, "virtual audio runtime stopped");
        if let Some(inner) = inner.upgrade() {
            mark_audio_unavailable(&inner, error);
        }
    }
    if !input_finished {
        input_task.abort();
        let _ = input_task.await;
    }
    if !output_finished {
        output_task.abort();
        let _ = output_task.await;
    }
    if keepalive.try_wait().ok().flatten().is_none() {
        let _ = keepalive.kill().await;
        let _ = keepalive.wait().await;
    }
    pulse.cleanup().await;
}

fn worker_failure(
    device: &str,
    result: Result<std::io::Result<()>, tokio::task::JoinError>,
) -> String {
    match result {
        Ok(Ok(())) => format!("virtual {device} pipe stopped"),
        Ok(Err(error)) => format!("virtual {device} pipe stopped: {error}"),
        Err(error) => format!("virtual {device} pipe task failed: {error}"),
    }
}

fn mark_audio_unavailable(inner: &AudioHubInner, error: String) {
    inner.input.lock().take();
    let mut routes = inner.routes.lock();
    inner
        .status
        .send_replace(VirtualAudioStatus::unavailable(error));
    for route in routes.peers.values_mut() {
        route.input = false;
        route.output = false;
    }
    inner.active_inputs.lock().clear();
    let counts = routes.counts();
    inner.counts.send_replace(counts);
}

struct AudioPeer {
    id: Uuid,
    hub: AudioHub,
    input_enabled: bool,
    output_enabled: bool,
}

impl AudioPeer {
    async fn set_input(&mut self, enabled: bool) -> Result<(), String> {
        self.hub.set_route(self.id, Some(enabled), None).await?;
        self.input_enabled = enabled;
        Ok(())
    }

    async fn set_output(&mut self, enabled: bool) -> Result<(), String> {
        self.hub.set_route(self.id, None, Some(enabled)).await?;
        self.output_enabled = enabled;
        Ok(())
    }
}

impl Drop for AudioPeer {
    fn drop(&mut self) {
        self.hub.detach(self.id);
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum AudioClientMessage {
    Input { enabled: bool },
    Output { enabled: bool },
    Ping,
}

pub async fn serve_audio_socket(socket: WebSocket, hub: AudioHub) {
    let (mut sender, mut receiver) = socket.split();
    let mut peer = hub.attach();
    let mut status = hub.status_receiver();
    let mut counts = hub.counts_receiver();
    let mut output = hub.output_receiver();
    status.borrow_and_update();
    counts.borrow_and_update();
    if send_ready(&mut sender, &hub).await.is_err() {
        return;
    }

    loop {
        tokio::select! {
            message = receiver.next() => {
                let Some(Ok(message)) = message else { break };
                match message {
                    Message::Text(text) => {
                        match serde_json::from_str::<AudioClientMessage>(&text) {
                            Ok(AudioClientMessage::Ping) => {
                                if send_json(&mut sender, serde_json::json!({ "type": "pong" }))
                                    .await
                                    .is_err()
                                {
                                    break;
                                }
                            }
                            Ok(message) => {
                                let result = match message {
                                    AudioClientMessage::Input { enabled } => {
                                        peer.set_input(enabled).await
                                    }
                                    AudioClientMessage::Output { enabled } => {
                                        peer.set_output(enabled).await
                                    }
                                    AudioClientMessage::Ping => unreachable!(),
                                };
                                if let Err(error) = result {
                                    if send_error(&mut sender, &error).await.is_err() { break }
                                } else if send_state(&mut sender, &peer, hub.counts()).await.is_err() {
                                    break;
                                }
                            }
                            Err(_) => {
                                if send_error(&mut sender, "invalid virtual audio control message")
                                    .await
                                    .is_err()
                                {
                                    break;
                                }
                            }
                        }
                    }
                    Message::Binary(data) => {
                        if !peer.input_enabled {
                            if send_error(&mut sender, "select a browser microphone before sending audio").await.is_err() { break }
                        } else if data.len() != AUDIO_FRAME_BYTES {
                            if send_error(&mut sender, "invalid virtual audio frame size").await.is_err() { break }
                        } else {
                            hub.push_input(peer.id, data);
                        }
                    }
                    Message::Ping(data) => {
                        if sender.send(Message::Pong(data)).await.is_err() { break }
                    }
                    Message::Close(_) => break,
                    Message::Pong(_) => {}
                }
            }
            changed = status.changed() => {
                if changed.is_err() { break }
                if !status.borrow_and_update().available {
                    peer.input_enabled = false;
                    peer.output_enabled = false;
                }
                if send_ready(&mut sender, &hub).await.is_err() { break }
            }
            changed = counts.changed() => {
                if changed.is_err() { break }
                let current = *counts.borrow_and_update();
                if send_state(&mut sender, &peer, current).await.is_err() { break }
            }
            frame = output.recv(), if peer.output_enabled => {
                match frame {
                    Ok(frame) => {
                        if sender.send(Message::Binary(frame)).await.is_err() { break }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => {
                        let _ = send_error(&mut sender, "virtual speaker stream stopped").await;
                        break;
                    }
                }
            }
        }
    }
}

async fn send_ready(
    sender: &mut SplitSink<WebSocket, Message>,
    hub: &AudioHub,
) -> Result<(), axum::Error> {
    let status = hub.status();
    let counts = hub.counts();
    send_json(
        sender,
        serde_json::json!({
            "type": "ready",
            "available": status.available,
            "inputDevice": status.input_device,
            "outputDevice": status.output_device,
            "sampleRate": status.sample_rate,
            "channels": status.channels,
            "frameSamples": status.frame_samples,
            "jitterFrames": status.jitter_frames,
            "inputPeers": counts.input_peers,
            "outputPeers": counts.output_peers,
            "error": status.error,
        }),
    )
    .await
}

async fn send_state(
    sender: &mut SplitSink<WebSocket, Message>,
    peer: &AudioPeer,
    counts: AudioPeerCounts,
) -> Result<(), axum::Error> {
    send_json(
        sender,
        serde_json::json!({
            "type": "state",
            "inputEnabled": peer.input_enabled,
            "outputEnabled": peer.output_enabled,
            "inputPeers": counts.input_peers,
            "outputPeers": counts.output_peers,
        }),
    )
    .await
}

async fn send_error(
    sender: &mut SplitSink<WebSocket, Message>,
    error: &str,
) -> Result<(), axum::Error> {
    send_json(
        sender,
        serde_json::json!({ "type": "error", "message": error }),
    )
    .await
}

async fn send_json(
    sender: &mut SplitSink<WebSocket, Message>,
    value: serde_json::Value,
) -> Result<(), axum::Error> {
    sender.send(Message::Text(value.to_string().into())).await
}

#[derive(Default)]
struct AudioMixer {
    peers: HashMap<Uuid, PeerJitterBuffer>,
    active: Vec<Bytes>,
}

#[derive(Default)]
struct PeerJitterBuffer {
    frames: VecDeque<Bytes>,
    playing: bool,
}

impl AudioMixer {
    fn push(&mut self, peer: Uuid, data: Bytes) {
        if data.len() != AUDIO_FRAME_BYTES {
            return;
        }
        let buffer = self.peers.entry(peer).or_default();
        if buffer.frames.len() >= AUDIO_MAX_QUEUED_FRAMES {
            while buffer.frames.len() > AUDIO_JITTER_FRAMES {
                buffer.frames.pop_front();
            }
        }
        buffer.frames.push_back(data);
    }

    fn retain(&mut self, active: &HashSet<Uuid>) {
        self.peers.retain(|peer, _| active.contains(peer));
    }

    fn mix_into(&mut self, output: &mut [u8; AUDIO_FRAME_BYTES]) {
        self.active.clear();
        for buffer in self.peers.values_mut() {
            if !buffer.playing && buffer.frames.len() >= AUDIO_JITTER_FRAMES {
                buffer.playing = true;
            }
            if !buffer.playing {
                continue;
            }
            match buffer.frames.pop_front() {
                Some(frame) => self.active.push(frame),
                None => buffer.playing = false,
            }
        }
        if self.active.is_empty() {
            output.fill(0);
            return;
        }
        let divisor = i32::try_from(self.active.len()).unwrap_or(i32::MAX);
        for sample in 0..AUDIO_FRAME_SAMPLES {
            let offset = sample * 2;
            let sum = self
                .active
                .iter()
                .map(|frame| i32::from(i16::from_le_bytes([frame[offset], frame[offset + 1]])))
                .sum::<i32>();
            let mixed = (sum / divisor).clamp(i32::from(i16::MIN), i32::from(i16::MAX)) as i16;
            output[offset..offset + 2].copy_from_slice(&mixed.to_le_bytes());
        }
    }
}

async fn run_input_pipe(
    mut pipe: Sender,
    mut receiver: mpsc::Receiver<InputFrame>,
    active_inputs: Arc<SyncMutex<HashSet<Uuid>>>,
) -> std::io::Result<()> {
    let mut mixer = AudioMixer::default();
    let mut output = [0_u8; AUDIO_FRAME_BYTES];
    let mut interval = tokio::time::interval(AUDIO_FRAME_DURATION);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    interval.tick().await;
    loop {
        tokio::select! {
            frame = receiver.recv() => match frame {
                Some(InputFrame { peer, data }) => {
                    if active_inputs.lock().contains(&peer) {
                        mixer.push(peer, data);
                    }
                }
                None => return Ok(()),
            },
            _ = interval.tick() => {
                mixer.retain(&active_inputs.lock());
                mixer.mix_into(&mut output);
                pipe.write_all(&output).await?;
            }
        }
    }
}

async fn run_output_pipe(
    mut pipe: Receiver,
    output: broadcast::Sender<Bytes>,
) -> std::io::Result<()> {
    loop {
        let mut frame = vec![0_u8; AUDIO_FRAME_BYTES];
        pipe.read_exact(&mut frame).await?;
        let _ = output.send(Bytes::from(frame));
    }
}

struct PulseSetup {
    _directory: TempDir,
    input_name: String,
    output_name: String,
    input_module: u32,
    output_module: u32,
    previous_input: String,
    previous_output: String,
}

#[derive(Debug, PartialEq, Eq)]
struct PulseModule {
    id: u32,
    device_name: String,
}

impl PulseSetup {
    async fn sweep_stale() -> Result<(), String> {
        let modules = pactl(&["list", "short", "modules"]).await?;
        let mut stale = Vec::new();
        for module in parse_virtual_audio_modules(&modules) {
            let Some(pid) = virtual_audio_pid(&module.device_name) else {
                continue;
            };
            if !process_is_alive(pid) {
                stale.push(module);
            }
        }
        if stale.is_empty() {
            return Ok(());
        }

        let stale_devices = stale
            .iter()
            .map(|module| module.device_name.as_str())
            .collect::<HashSet<_>>();
        let input_repair = repair_stale_default(
            "source",
            "get-default-source",
            "set-default-source",
            &stale_devices,
        )
        .await
        .err();
        let output_repair = repair_stale_default(
            "sink",
            "get-default-sink",
            "set-default-sink",
            &stale_devices,
        )
        .await
        .err();
        let mut cleanup_error = input_repair.or(output_repair);
        for module in stale {
            if let Err(error) =
                pactl_owned(vec!["unload-module".to_owned(), module.id.to_string()]).await
            {
                cleanup_error.get_or_insert(error);
            }
        }
        cleanup_error.map_or(Ok(()), Err)
    }

    async fn start() -> Result<(Self, Sender, Receiver, Child), String> {
        let previous_input = pactl(&["get-default-source"]).await?;
        let previous_output = pactl(&["get-default-sink"]).await?;
        let directory = tempfile::Builder::new()
            .prefix("term-server-audio-")
            .tempdir()
            .map_err(|error| format!("unable to create audio pipes: {error}"))?;
        let suffix = std::process::id();
        let input_name = format!("term_server_microphone_{suffix}");
        let output_name = format!("term_server_speaker_{suffix}");
        let input_path = directory.path().join("microphone.pcm");
        let output_path = directory.path().join("speaker.pcm");

        let input_module = load_module(
            "module-pipe-source",
            &[
                format!("source_name={input_name}"),
                format!("file={}", input_path.display()),
                "format=s16le".to_owned(),
                format!("rate={AUDIO_SAMPLE_RATE}"),
                format!("channels={AUDIO_CHANNELS}"),
                "channel_map=mono".to_owned(),
                format!("source_properties='device.description=\"{VIRTUAL_MICROPHONE}\"'"),
            ],
        )
        .await?;
        let output_module = match load_module(
            "module-pipe-sink",
            &[
                format!("sink_name={output_name}"),
                format!("file={}", output_path.display()),
                "format=s16le".to_owned(),
                format!("rate={AUDIO_SAMPLE_RATE}"),
                format!("channels={AUDIO_CHANNELS}"),
                "channel_map=mono".to_owned(),
                format!("sink_properties='device.description=\"{VIRTUAL_SPEAKER}\"'"),
            ],
        )
        .await
        {
            Ok(module) => module,
            Err(error) => {
                let _ =
                    pactl_owned(vec!["unload-module".to_owned(), input_module.to_string()]).await;
                return Err(error);
            }
        };

        let setup = Self {
            _directory: directory,
            input_name,
            output_name,
            input_module,
            output_module,
            previous_input,
            previous_output,
        };
        let result = async {
            let input_pipe = open_sender(&input_path).await?;
            let output_pipe = open_receiver(&output_path).await?;
            pactl_owned(vec![
                "set-default-source".to_owned(),
                setup.input_name.clone(),
            ])
            .await?;
            pactl_owned(vec![
                "set-default-sink".to_owned(),
                setup.output_name.clone(),
            ])
            .await?;
            let mut command = Command::new("parec");
            command
                .arg("--raw")
                .arg(format!("--device={}", setup.input_name))
                .arg("--format=s16le")
                .arg(format!("--rate={AUDIO_SAMPLE_RATE}"))
                .arg(format!("--channels={AUDIO_CHANNELS}"))
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            let mut keepalive = command
                .spawn()
                .map_err(|error| format!("could not run parec: {error}"))?;
            tokio::time::sleep(Duration::from_millis(50)).await;
            if let Some(status) = keepalive
                .try_wait()
                .map_err(|error| format!("could not inspect parec: {error}"))?
            {
                return Err(format!(
                    "parec stopped during virtual microphone setup ({status})"
                ));
            }
            Ok::<_, String>((input_pipe, output_pipe, keepalive))
        }
        .await;
        match result {
            Ok((input_pipe, output_pipe, keepalive)) => {
                Ok((setup, input_pipe, output_pipe, keepalive))
            }
            Err(error) => {
                setup.cleanup().await;
                Err(error)
            }
        }
    }

    async fn cleanup(&self) {
        if pactl(&["get-default-source"]).await.ok().as_deref() == Some(self.input_name.as_str()) {
            let _ = pactl_owned(vec![
                "set-default-source".to_owned(),
                self.previous_input.clone(),
            ])
            .await;
        }
        if pactl(&["get-default-sink"]).await.ok().as_deref() == Some(self.output_name.as_str()) {
            let _ = pactl_owned(vec![
                "set-default-sink".to_owned(),
                self.previous_output.clone(),
            ])
            .await;
        }
        let _ = pactl_owned(vec![
            "unload-module".to_owned(),
            self.output_module.to_string(),
        ])
        .await;
        let _ = pactl_owned(vec![
            "unload-module".to_owned(),
            self.input_module.to_string(),
        ])
        .await;
    }
}

async fn open_sender(path: &Path) -> Result<Sender, String> {
    open_pipe(path, |options, path| options.open_sender(path)).await
}

async fn open_receiver(path: &Path) -> Result<Receiver, String> {
    open_pipe(path, |options, path| options.open_receiver(path)).await
}

async fn open_pipe<T>(
    path: &Path,
    open: impl Fn(&pipe::OpenOptions, &Path) -> std::io::Result<T>,
) -> Result<T, String> {
    let mut last_error = None;
    for _ in 0..50 {
        let mut options = pipe::OpenOptions::new();
        options.read_write(true);
        match open(&options, path) {
            Ok(pipe) => return Ok(pipe),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                last_error = Some(error);
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(error) => return Err(format!("unable to open virtual audio pipe: {error}")),
        }
    }
    Err(format!(
        "virtual audio pipe was not created: {}",
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "unknown error".to_owned())
    ))
}

fn parse_virtual_audio_modules(output: &str) -> Vec<PulseModule> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(4, '\t');
            let id = fields.next()?.parse::<u32>().ok()?;
            let module_name = fields.next()?;
            let arguments = fields.next()?;
            let name_key = match module_name {
                "module-pipe-source" => "source_name=",
                "module-pipe-sink" => "sink_name=",
                _ => return None,
            };
            let device_name = arguments
                .split_ascii_whitespace()
                .find_map(|argument| argument.strip_prefix(name_key))?;
            virtual_audio_pid(device_name)?;
            Some(PulseModule {
                id,
                device_name: device_name.to_owned(),
            })
        })
        .collect()
}

fn virtual_audio_pid(device_name: &str) -> Option<u32> {
    ["term_server_microphone_", "term_server_speaker_"]
        .iter()
        .find_map(|prefix| device_name.strip_prefix(prefix))
        .and_then(|pid| pid.parse::<u32>().ok())
}

fn process_is_alive(pid: u32) -> bool {
    let Some(pid) = i32::try_from(pid)
        .ok()
        .and_then(rustix::process::Pid::from_raw)
    else {
        return false;
    };
    !matches!(
        rustix::process::test_kill_process(pid),
        Err(rustix::io::Errno::SRCH)
    )
}

async fn repair_stale_default(
    kind: &str,
    get_default: &str,
    set_default: &str,
    stale_devices: &HashSet<&str>,
) -> Result<(), String> {
    let current = pactl(&[get_default]).await?;
    if !stale_devices.contains(current.as_str()) {
        return Ok(());
    }
    let list_kind = if kind == "source" { "sources" } else { "sinks" };
    let devices = pactl(&["list", "short", list_kind]).await?;
    let fallback = devices
        .lines()
        .filter_map(|line| line.split('\t').nth(1))
        .find(|name| virtual_audio_pid(name).is_none())
        .ok_or_else(|| format!("no host {kind} is available to replace stale virtual audio"))?;
    pactl_owned(vec![set_default.to_owned(), fallback.to_owned()])
        .await
        .map(|_| ())
}

async fn load_module(name: &str, arguments: &[String]) -> Result<u32, String> {
    let mut command = vec!["load-module".to_owned(), name.to_owned()];
    command.extend_from_slice(arguments);
    let output = pactl_owned(command).await?;
    output
        .parse::<u32>()
        .map_err(|_| format!("pactl returned an invalid module id: {output}"))
}

async fn pactl(arguments: &[&str]) -> Result<String, String> {
    pactl_owned(
        arguments
            .iter()
            .map(|argument| (*argument).to_owned())
            .collect(),
    )
    .await
}

async fn pactl_owned(arguments: Vec<String>) -> Result<String, String> {
    let output = Command::new("pactl")
        .args(&arguments)
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|error| format!("could not run pactl: {error}"))?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(if message.is_empty() {
            format!("pactl {} failed", arguments.join(" "))
        } else {
            message
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn truncate_error(error: &str, maximum: usize) -> String {
    if error.len() <= maximum {
        return error.to_owned();
    }
    let mut end = maximum;
    while !error.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &error[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(sample: i16) -> Bytes {
        let mut data = vec![0_u8; AUDIO_FRAME_BYTES];
        for chunk in data.as_chunks_mut::<2>().0 {
            chunk.copy_from_slice(&sample.to_le_bytes());
        }
        Bytes::from(data)
    }

    fn first_sample(data: &[u8]) -> i16 {
        i16::from_le_bytes([data[0], data[1]])
    }

    #[test]
    fn jitter_buffer_waits_for_target_before_playing() {
        let peer = Uuid::new_v4();
        let mut mixer = AudioMixer::default();
        let mut output = [0_u8; AUDIO_FRAME_BYTES];
        mixer.push(peer, frame(700));
        mixer.push(peer, frame(700));
        mixer.mix_into(&mut output);
        assert_eq!(first_sample(&output), 0);
        mixer.push(peer, frame(700));
        mixer.mix_into(&mut output);
        assert_eq!(first_sample(&output), 700);
    }

    #[test]
    fn mixer_averages_concurrent_browser_inputs() {
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        let mut mixer = AudioMixer::default();
        for _ in 0..AUDIO_JITTER_FRAMES {
            mixer.push(first, frame(1_000));
            mixer.push(second, frame(-500));
        }
        let mut output = [0_u8; AUDIO_FRAME_BYTES];
        mixer.mix_into(&mut output);
        assert_eq!(first_sample(&output), 250);
    }

    #[test]
    fn mixer_discards_audio_from_detached_inputs() {
        let peer = Uuid::new_v4();
        let mut mixer = AudioMixer::default();
        for _ in 0..AUDIO_JITTER_FRAMES {
            mixer.push(peer, frame(700));
        }
        mixer.retain(&HashSet::new());
        let mut output = [0_u8; AUDIO_FRAME_BYTES];
        mixer.mix_into(&mut output);
        assert_eq!(first_sample(&output), 0);
    }

    #[test]
    fn jitter_buffer_rebuffers_after_an_underrun() {
        let peer = Uuid::new_v4();
        let mut mixer = AudioMixer::default();
        for _ in 0..AUDIO_JITTER_FRAMES {
            mixer.push(peer, frame(400));
        }
        let mut output = [0_u8; AUDIO_FRAME_BYTES];
        for _ in 0..AUDIO_JITTER_FRAMES {
            mixer.mix_into(&mut output);
            assert_eq!(first_sample(&output), 400);
        }
        mixer.mix_into(&mut output);
        assert_eq!(first_sample(&output), 0);
        mixer.push(peer, frame(900));
        mixer.mix_into(&mut output);
        assert_eq!(first_sample(&output), 0);
    }

    #[test]
    fn oversized_jitter_queue_discards_stale_audio() {
        let peer = Uuid::new_v4();
        let mut mixer = AudioMixer::default();
        for sample in 0..=AUDIO_MAX_QUEUED_FRAMES {
            mixer.push(peer, frame(sample as i16));
        }
        let mut output = [0_u8; AUDIO_FRAME_BYTES];
        mixer.mix_into(&mut output);
        assert_eq!(first_sample(&output), 22);
    }

    #[test]
    fn parses_only_term_server_pipe_modules() {
        let modules = parse_virtual_audio_modules(
            "41\tmodule-pipe-source\tsource_name=term_server_microphone_123 file=/tmp/mic\t0\n\
             42\tmodule-pipe-sink\tsink_name=term_server_speaker_456 file=/tmp/speaker\t0\n\
             43\tmodule-null-sink\tsink_name=term_server_speaker_789\t0\n\
             44\tmodule-pipe-sink\tsink_name=unrelated\t0",
        );
        assert_eq!(
            modules,
            vec![
                PulseModule {
                    id: 41,
                    device_name: "term_server_microphone_123".to_owned(),
                },
                PulseModule {
                    id: 42,
                    device_name: "term_server_speaker_456".to_owned(),
                },
            ]
        );
    }

    #[tokio::test]
    #[ignore = "requires a disposable PulseAudio/PipeWire session and parec"]
    async fn pulse_setup_restores_host_defaults() {
        PulseSetup::sweep_stale().await.unwrap();
        let previous_input = pactl(&["get-default-source"]).await.unwrap();
        let previous_output = pactl(&["get-default-sink"]).await.unwrap();
        let (setup, input_pipe, output_pipe, mut keepalive) = PulseSetup::start().await.unwrap();
        let active_input = pactl(&["get-default-source"]).await;
        let active_output = pactl(&["get-default-sink"]).await;

        let _ = keepalive.kill().await;
        let _ = keepalive.wait().await;
        drop(input_pipe);
        drop(output_pipe);
        setup.cleanup().await;

        assert_eq!(active_input.unwrap(), setup.input_name);
        assert_eq!(active_output.unwrap(), setup.output_name);
        assert_eq!(
            pactl(&["get-default-source"]).await.unwrap(),
            previous_input
        );
        assert_eq!(pactl(&["get-default-sink"]).await.unwrap(), previous_output);
    }

    #[test]
    fn truncation_preserves_utf8_boundaries() {
        assert_eq!(truncate_error("1234é", 5), "1234…");
    }
}
