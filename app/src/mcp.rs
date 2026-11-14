//! Agent auf dem Desktop: die Werkzeuge des Kerns (`klang_app::agent`) als
//! MCP-Server über HTTP auf 127.0.0.1 – plus das, was nur der Desktop kann
//! (Fenster nach vorn holen, Bibliotheken herunterladen und verwalten).
//! Im Browser stellt der Web-Kern dieselben Werkzeuge in der Seite bereit.

use crate::state::AppState;
use klang_app::agent::{Agent, AgentShell};
use klang_mcp::DEFAULT_PORT;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

/// Die Plattform „Desktop“ für die Werkzeuge.
struct DesktopShell(AppHandle);

impl AgentShell for DesktopShell {
    fn state(&self) -> &AppState {
        self.0.state::<AppState>().inner()
    }

    fn open_in_window(&self, path: &Path) -> Result<(), String> {
        let _ = self.0.emit("open-file", path.display().to_string());
        // nach vorn holen – außer im Hintergrundmodus der Tests
        if let Some(w) = self.0.get_webview_window("main").filter(|_| !crate::background_mode()) {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
        Ok(())
    }

    fn pack_ids(&self) -> Vec<&'static str> {
        crate::library::pack_ids()
    }

    fn library_download(&self, id: &str) -> Result<(PathBuf, Option<usize>), String> {
        Ok(match crate::library::start_download(&self.0, id, None, true)? {
            crate::library::Started::Now(dir) => (dir, None),
            crate::library::Started::Queued(dir, platz) => (dir, Some(platz)),
        })
    }

    fn library_add(&self, paths: &[String]) -> Result<String, String> {
        crate::library::start_add(&self.0, paths)
    }

    fn libraries(&self) -> Value {
        serde_json::to_value(crate::libraries::list(&self.0)).unwrap_or_default()
    }

    fn library_switch(&self, name: &str) -> Result<(), String> {
        let id = crate::libraries::resolve(&self.0, name)?;
        crate::libraries::activate(&self.0, &id)
    }

    fn library_create(&self, name: &str, activate: bool) -> Result<(String, String), String> {
        let entry = crate::libraries::create(&self.0, name)?;
        if activate {
            crate::libraries::activate(&self.0, &entry.id)?;
        }
        Ok((entry.id, entry.name))
    }

    fn library_delete(&self, name: &str) -> Result<String, String> {
        let id = crate::libraries::resolve(&self.0, name)?;
        crate::libraries::delete(&self.0, &id)?;
        Ok(id)
    }
}

/// Startet den MCP-Server auf 127.0.0.1 (Port aus KLANGWELT_MCP_PORT, sonst 7419).
pub fn start(app: AppHandle) {
    let port = std::env::var("KLANGWELT_MCP_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(DEFAULT_PORT);
    let token = std::env::var("KLANGWELT_MCP_TOKEN").ok().filter(|t| !t.is_empty());
    let handler = Arc::new(Agent::new(DesktopShell(app.clone())));
    let state = app.state::<AppState>();
    let Ok(mut link) = state.agent.lock() else { return };
    match klang_mcp::serve(("127.0.0.1", port), handler, token) {
        Ok(server) => {
            eprintln!("MCP-Server: {}", server.url());
            link.url = Some(server.url());
            link.server = Some(server);
        }
        Err(e) => {
            eprintln!("MCP-Server konnte nicht starten: {e}");
            link.error = Some(klang_i18n::tr!("Port {port} is in use or not available: {error}", port = port, error = e));
        }
    }
}
