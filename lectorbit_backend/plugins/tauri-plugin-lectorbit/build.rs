const COMMANDS: &[&str] = &[
    "app_get_version",
    "app_get_diagnostics",
    "library_list_roots",
    "library_pick_and_register_root",
    "library_revoke_root",
    "library_enqueue_scan",
    "library_list_scan_jobs",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
