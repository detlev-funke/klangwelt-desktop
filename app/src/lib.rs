//! Klangwelt-App (Desktop): die Tauri-Hülle um den gemeinsamen Kern
//! (`klang-app`).
//!
//! * Jeder Aufruf der Oberfläche, den der Kern kennt, geht an dessen
//!   Befehlstabelle (`klang_app::commands`) – dieselbe, die im Browser der
//!   Web-Kern benutzt. Hier stehen nur Befehle, die es nur auf dem Desktop
//!   gibt (Fenster schließen, „Im Ordner zeigen“, Bibliotheken herunterladen
//!   und verwalten).
//! * Der [`klang_app::Host`] des Desktops: Tauri-Events und die Ordner des
//!   Betriebssystems.
//! * Dazu der MCP-Server für den Agenten (`mcp.rs`) und die Kommandozeile.

pub mod cli;
mod libraries;
mod library;
mod mcp;

// Module des Kerns, die die Hülle selbst braucht.
use klang_app::{settings, state};

use klang_app::commands;
use serde::Serialize;
use state::AppState;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::ipc::{Invoke, InvokeBody, InvokeError, InvokeResponseBody};
use tauri::{Emitter, Manager};

/// Die Plattform für den Kern: Tauri-Events und die Ordner des Betriebssystems.
struct DesktopHost(tauri::AppHandle);

impl klang_app::Host for DesktopHost {
    fn emit_json(&self, event: &str, json: String) {
        let _ = self.0.emit_str(event, json);
    }

    /// Dokumente/Klangwelt/Projekte.
    fn projects_dir(&self) -> PathBuf {
        let p = self.0.path();
        p.document_dir()
            .or_else(|_| p.app_data_dir())
            .unwrap_or_else(|_| std::env::temp_dir())
            .join("Klangwelt")
            .join("Projekte")
    }

    fn library_root(&self) -> PathBuf {
        library::default_root(&self.0)
    }
}

/// Datei der Einstellungen: lokaler App-Datenordner; mit `KLANGWELT_BIBLIOTHEK`
/// in jenem Ordner (Tests).
fn settings_file(app: &tauri::AppHandle) -> PathBuf {
    if let Some(r) = std::env::var_os("KLANGWELT_BIBLIOTHEK").filter(|r| !r.is_empty()) {
        return PathBuf::from(r).join(settings::FILE);
    }
    let p = app.path();
    p.app_local_data_dir().or_else(|_| p.app_data_dir()).unwrap_or_else(|_| std::env::temp_dir()).join(settings::FILE)
}

// ---------------------------------------------------------------- Befehle nur für den Desktop

/// Warum das Schließen angehalten wurde.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CloseInfo {
    dirty: bool,
    /// Laufende Bibliotheksarbeit (Herunterladen, Indizieren) in Worten.
    busy: Option<String>,
}

/// Zeigt eine exportierte Datei im Dateimanager (Explorer, Finder; unter Linux
/// den Ordner).
#[tauri::command]
async fn export_reveal(path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err(klang_i18n::tr!("{path} no longer exists", path = path));
    }
    #[cfg(windows)]
    {
        let arg = if p.is_dir() { p.display().to_string() } else { format!("/select,{}", p.display()) };
        std::process::Command::new("explorer").arg(arg).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        if !p.is_dir() {
            cmd.arg("-R"); // im Finder markieren
        }
        cmd.arg(&p).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = if p.is_dir() { p.clone() } else { p.parent().map(std::path::Path::to_path_buf).unwrap_or_else(|| p.clone()) };
        std::process::Command::new("xdg-open").arg(dir).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Schließt die App, auch mit ungespeicherten Änderungen (nach Rückfrage in der Oberfläche).
#[tauri::command]
async fn app_close(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.force_close.store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}

// ---------------------------------------------------------------- Weiterleitung an den Kern

/// Ein Aufruf, den der Kern kennt: im Hintergrund ausführen (wie zuvor die
/// `async`-Befehle) und die fertige JSON-Antwort zurückgeben. Der Export
/// rendert lange – er läuft auf einem eigenen Thread, die Oberfläche bleibt
/// bedienbar.
fn invoke_core(invoke: Invoke) {
    let Invoke { message, resolver, .. } = invoke;
    let long = LONG_RUNNING.contains(&message.command());
    let run = move || {
        let webview = message.webview();
        let state = webview.state::<AppState>();
        let null = serde_json::Value::Null;
        let args = match message.payload() {
            InvokeBody::Json(v) => v,
            InvokeBody::Raw(_) => &null,
        };
        commands::call(&state, message.command(), args).map(InvokeResponseBody::Json).map_err(|e| InvokeError(serde_json::Value::String(e)))
    };
    if long {
        resolver.respond_async_serialized(async move {
            tauri::async_runtime::spawn_blocking(run)
                .await
                .map_err(|e| InvokeError(serde_json::Value::String(klang_i18n::tr!("Cancelled: {error}", error = e))))?
        });
    } else {
        resolver.respond_async_serialized(async move { run() });
    }
}

/// Befehle, die lange rechnen und auf einem eigenen Thread laufen (nicht auf
/// einem der Ablaufsteuerung).
const LONG_RUNNING: &[&str] = &["export_run"];

fn status_loop(handle: tauri::AppHandle) {
    let mut connected = false;
    for tick in 0u64.. {
        std::thread::sleep(Duration::from_millis(33));
        let st = handle.state::<AppState>();
        if handle.emit("engine-status", st.status()).is_err() {
            break;
        }
        // Agent verbunden/getrennt (auch abgelaufen) – etwa zweimal pro Sekunde prüfen
        if tick % 15 == 0 && st.agent_connected() != connected {
            let view = st.chat_view();
            connected = view.agent_connected;
            let _ = handle.emit("chat-changed", view);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    run_with(None)
}

/// `KLANGWELT_HINTERGRUND=1`: Fenster für automatische Tests im Hintergrund –
/// außerhalb des Bildschirms, ohne Taskleiste, ohne Fokus. Die Oberfläche
/// läuft und zeichnet trotzdem (Tests bedienen sie über den Debug-Port).
pub fn background_mode() -> bool {
    std::env::var_os("KLANGWELT_HINTERGRUND").is_some_and(|v| !v.is_empty() && v != "0")
}

fn show_in_background(w: &tauri::WebviewWindow) {
    let _ = w.set_skip_taskbar(true);
    let _ = w.set_position(tauri::PhysicalPosition::new(-24000, -24000));
    #[cfg(windows)]
    if let Ok(hwnd) = w.hwnd() {
        #[link(name = "user32")]
        extern "system" {
            fn ShowWindow(hwnd: *mut std::ffi::c_void, cmd: i32) -> i32;
        }
        const SW_SHOWNOACTIVATE: i32 = 4;
        // SAFETY: gültiges Fensterhandle des eigenen Fensters.
        unsafe {
            ShowWindow(hwnd.0 as _, SW_SHOWNOACTIVATE);
        }
    }
    #[cfg(not(windows))]
    let _ = w.show();
}

/// Befehle nur für den Desktop; alles andere beantwortet der Kern.
fn desktop_commands() -> impl Fn(Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        app_close,
        export_reveal,
        library::library_add,
        libraries::library_list,
        libraries::library_create,
        libraries::library_switch,
        libraries::library_rename,
        libraries::library_delete,
        library::library_catalog,
        library::library_download,
        library::library_dequeue,
        library::library_cancel,
        library::library_enrich,
        library::library_reindex,
    ]
}

/// Startet das Fenster; `open`: Projektdatei, die gleich geöffnet wird
/// (Doppelklick auf eine .klangwelt-Datei).
pub fn run_with(open: Option<std::path::PathBuf>) {
    let desktop = desktop_commands();
    tauri::Builder::default()
        .manage(AppState::new())
        .setup(move |app| {
            let handle = app.handle().clone();
            app.state::<AppState>().set_host(Box::new(DesktopHost(handle.clone())));
            // Das Fenster startet unsichtbar (tauri.conf.json) und erscheint hier –
            // für automatische Tests im Hintergrund, ohne aufzuspringen.
            if let Some(w) = app.get_webview_window("main") {
                if background_mode() {
                    show_in_background(&w);
                } else {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            if let Some(p) = &open {
                if let Err(e) = app.state::<AppState>().open_project(p) {
                    eprintln!("{}: {e}", p.display());
                }
            }
            // Gemerkte Einstellungen anwenden (Metronom an/aus, Audiogeräte vom letzten Mal)
            {
                let st = app.state::<AppState>();
                let file = settings_file(&handle);
                let saved = settings::read(&file);
                if let Some(on) = saved.get("metronom").and_then(serde_json::Value::as_bool) {
                    let _ = st.set_metronome(on);
                }
                st.apply_audio_settings(&saved);
                *st.settings_file.lock().unwrap_or_else(|e| e.into_inner()) = Some(file);
            }
            mcp::start(handle.clone());
            // Aktive Bibliothek laden (beim ersten Mal einrichten), danach
            // unterbrochenes Herunterladen/Übernehmen fortsetzen
            libraries::startup(&handle);
            std::thread::Builder::new().name("klang-status".into()).spawn(move || status_loop(handle))?;
            Ok(())
        })
        // Ungespeicherte Änderungen oder laufende Bibliotheksarbeit: Schließen
        // anhalten, die Oberfläche fragt nach.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let st = window.state::<AppState>();
                let busy = library::busy(&st);
                if (st.is_dirty() || busy.is_some()) && !st.force_close.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.emit("close-requested", CloseInfo { dirty: st.is_dirty(), busy });
                }
            }
        })
        .invoke_handler(move |invoke| {
            if commands::has(invoke.message.command()) {
                invoke_core(invoke);
                true
            } else {
                desktop(invoke)
            }
        })
        .run(tauri::generate_context!())
        .expect("Klangwelt konnte nicht gestartet werden");
}
