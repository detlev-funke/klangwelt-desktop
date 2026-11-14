// In the release build on Windows, do not open an additional console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use klangwelt_lib::cli::{self, Mode};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match cli::parse(&args) {
        Mode::Gui { open } => {
            // Double-click on a project, Klangwelt already running: open it there
            if let Some(p) = &open {
                if cli::forward_open(p) {
                    return;
                }
            }
            klangwelt_lib::run_with(open)
        }
        mode => std::process::exit(cli::run(mode)),
    }
}
