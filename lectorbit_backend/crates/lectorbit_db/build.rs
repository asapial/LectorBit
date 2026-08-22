use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha384};

const MIGRATIONS_DIR: &str = "../../migrations";
const CHECKSUM_LOCK: &str = "checksums.sha384";

fn main() {
    let manifest_dir = PathBuf::from(
        env::var_os("CARGO_MANIFEST_DIR").expect("Cargo must set CARGO_MANIFEST_DIR"),
    );
    let migrations_dir = manifest_dir.join(MIGRATIONS_DIR);
    let lock_path = migrations_dir.join(CHECKSUM_LOCK);

    // `sqlx::migrate!` embeds these files. Without explicit change tracking,
    // Cargo can keep stale migration bytes in an incremental development build.
    println!("cargo:rerun-if-changed={}", migrations_dir.display());
    println!("cargo:rerun-if-changed={}", lock_path.display());

    let expected = read_checksum_lock(&lock_path);
    let actual = read_migration_checksums(&migrations_dir);

    if expected != actual {
        report_mismatch(&expected, &actual, &lock_path);
    }
}

fn read_checksum_lock(path: &Path) -> BTreeMap<String, String> {
    let contents = fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("read migration checksum lock {}: {error}", path.display()));
    let mut checksums = BTreeMap::new();

    for (index, line) in contents.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let mut fields = line.split_whitespace();
        let checksum = fields.next().unwrap_or_default().to_ascii_uppercase();
        let filename = fields.next().unwrap_or_default();
        if checksum.len() != 96
            || !checksum.bytes().all(|byte| byte.is_ascii_hexdigit())
            || filename.is_empty()
            || fields.next().is_some()
        {
            panic!(
                "invalid migration checksum lock entry at {}:{}",
                path.display(),
                index + 1
            );
        }
        if checksums.insert(filename.to_owned(), checksum).is_some() {
            panic!(
                "duplicate migration checksum lock entry for {filename} in {}",
                path.display()
            );
        }
    }

    checksums
}

fn read_migration_checksums(directory: &Path) -> BTreeMap<String, String> {
    let mut checksums = BTreeMap::new();
    let entries = fs::read_dir(directory).unwrap_or_else(|error| {
        panic!("read migration directory {}: {error}", directory.display())
    });

    for entry in entries {
        let entry = entry.unwrap_or_else(|error| {
            panic!(
                "read entry in migration directory {}: {error}",
                directory.display()
            )
        });
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("sql") {
            continue;
        }

        println!("cargo:rerun-if-changed={}", path.display());
        let filename = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_else(|| panic!("migration filename is not UTF-8: {}", path.display()));
        validate_migration_filename(filename);
        let bytes = fs::read(&path)
            .unwrap_or_else(|error| panic!("read migration {}: {error}", path.display()));
        let checksum = Sha384::digest(bytes);
        let checksum = checksum
            .iter()
            .map(|byte| format!("{byte:02X}"))
            .collect::<String>();
        checksums.insert(filename.to_owned(), checksum);
    }

    checksums
}

fn validate_migration_filename(filename: &str) {
    let Some((version, description)) = filename.split_once('_') else {
        panic!("invalid migration filename {filename:?}; expected <version>_<description>.sql");
    };
    if version.len() != 12
        || !version.bytes().all(|byte| byte.is_ascii_digit())
        || description.is_empty()
        || !description.ends_with(".sql")
    {
        panic!("invalid migration filename {filename:?}; expected 12 digits and a description");
    }
}

fn report_mismatch(
    expected: &BTreeMap<String, String>,
    actual: &BTreeMap<String, String>,
    lock_path: &Path,
) -> ! {
    let mut differences = Vec::new();

    for (filename, expected_checksum) in expected {
        match actual.get(filename) {
            Some(actual_checksum) if actual_checksum == expected_checksum => {}
            Some(actual_checksum) => differences.push(format!(
                "modified {filename}: expected {expected_checksum}, found {actual_checksum}"
            )),
            None => differences.push(format!("missing {filename}")),
        }
    }
    for filename in actual.keys() {
        if !expected.contains_key(filename) {
            differences.push(format!("unlocked migration {filename}"));
        }
    }

    panic!(
        "SQL migrations are append-only and their bytes are immutable:\n  {}\n\
         Restore modified migrations. For a genuinely new migration, add its SHA-384 to {}.",
        differences.join("\n  "),
        lock_path.display()
    );
}
