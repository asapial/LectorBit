const COMMANDS: &[&str] = &[
    "app_get_version",
    "app_get_diagnostics",
    "library_list_roots",
    "library_pick_and_register_root",
    "library_revoke_root",
    "library_enqueue_scan",
    "library_list_scan_jobs",
    "library_list_media",
    "planner_list_candidates",
    "planner_preview",
    "plan_commit",
    "plan_get_routine",
    "plan_replan",
    "playback_get_capability",
    "playback_open",
    "playback_play",
    "playback_pause",
    "playback_seek",
    "playback_set_speed",
    "playback_get_state",
    "playback_close",
    "study_record_action",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
