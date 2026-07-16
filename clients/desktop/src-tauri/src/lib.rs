use std::sync::Mutex;
use std::{env, path::PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct BridgeState {
    child: Mutex<Option<CommandChild>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case", tag = "type")]
enum RelayEvent {
    Frame { frame: Value },
    Error { message: String },
    Exited { code: Option<i32> },
}

#[tauri::command]
fn connect(
    app: AppHandle,
    state: State<'_, BridgeState>,
    on_event: Channel<RelayEvent>,
) -> Result<(), String> {
    let mut active_child = state.child.lock().map_err(|error| error.to_string())?;
    if active_child.is_some() {
        return Err("Vera is already connected".to_string());
    }

    let workspace = env::var_os("VERA_WORKSPACE")
        .map(PathBuf::from)
        // This bootstrap client runs Vera against the repository that built it.
        // Shared workspace selection replaces this bootstrap after stage 0.
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."));
    let command = app
        .shell()
        .sidecar("vera")
        .map_err(|error| error.to_string())?
        .current_dir(workspace)
        .args(["rpc"]);
    let (mut events, child) = command.spawn().map_err(|error| error.to_string())?;
    *active_child = Some(child);
    drop(active_child);

    let event_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut stdout = Vec::new();

        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    stdout.extend_from_slice(&bytes);
                    forward_lines(&mut stdout, &on_event);
                }
                CommandEvent::Stderr(bytes) => {
                    let message = String::from_utf8_lossy(&bytes).trim().to_string();
                    if !message.is_empty() {
                        let _ = on_event.send(RelayEvent::Error { message });
                    }
                }
                CommandEvent::Terminated(payload) => {
                    if let Ok(mut active_child) = event_app.state::<BridgeState>().child.lock() {
                        *active_child = None;
                    }
                    let _ = on_event.send(RelayEvent::Exited { code: payload.code });
                    return;
                }
                CommandEvent::Error(message) => {
                    let _ = on_event.send(RelayEvent::Error { message });
                }
                _ => {}
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn send_frame(state: State<'_, BridgeState>, frame: Value) -> Result<(), String> {
    let mut active_child = state.child.lock().map_err(|error| error.to_string())?;
    let child = active_child
        .as_mut()
        .ok_or_else(|| "Vera is not connected".to_string())?;
    let mut line = serde_json::to_vec(&frame).map_err(|error| error.to_string())?;
    line.push(b'\n');
    child.write(&line).map_err(|error| error.to_string())
}

fn forward_lines(buffer: &mut Vec<u8>, on_event: &Channel<RelayEvent>) {
    while let Some(line) = take_line(buffer) {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }

        match serde_json::from_slice(&line) {
            Ok(frame) => {
                let _ = on_event.send(RelayEvent::Frame { frame });
            }
            Err(error) => {
                let _ = on_event.send(RelayEvent::Error {
                    message: format!("Invalid frame from Vera: {error}"),
                });
            }
        }
    }
}

fn take_line(buffer: &mut Vec<u8>) -> Option<Vec<u8>> {
    let newline = buffer.iter().position(|byte| *byte == b'\n')?;
    let mut line: Vec<u8> = buffer.drain(..=newline).collect();
    line.pop();
    Some(line)
}

#[cfg(test)]
mod tests {
    use super::take_line;

    #[test]
    fn line_buffer_preserves_unicode_split_across_chunks() {
        let frame = "{\"type\":\"assistant_delta\",\"text\":\"hello 🙂\"}\n";
        let emoji = frame.find('🙂').expect("test frame has an emoji");
        let split = emoji + 2;
        let mut buffer = frame.as_bytes()[..split].to_vec();

        assert_eq!(take_line(&mut buffer), None);

        buffer.extend_from_slice(&frame.as_bytes()[split..]);
        let line = take_line(&mut buffer).expect("complete line");
        assert_eq!(
            String::from_utf8(line).expect("valid UTF-8"),
            &frame[..frame.len() - 1]
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(BridgeState {
            child: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![connect, send_frame])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Ok(mut active_child) = window.state::<BridgeState>().child.lock() {
                    if let Some(child) = active_child.take() {
                        let _ = child.kill();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Vera desktop client");
}
