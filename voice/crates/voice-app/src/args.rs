//! The command line.
//!
//! ```text
//! rukoo-voice [--fake-engine[=<scenario>]] [--self-test <folder>] [--import-ownkey <copy of config.json>]
//! ```
//!
//! `--fake-engine` and `--self-test` are development tools and only run when `RUKOO_VOICE_DATA_DIR`
//! is set. Windows starts Voice at login without arguments.

use std::ffi::OsString;
use std::path::PathBuf;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Args {
    /// Run the windows against [`crate::fake::FakeEngine`] with this scenario instead of the engine.
    pub fake_engine: Option<String>,
    /// Exercise the windows once and write a report and captures of the app's own windows here.
    pub self_test: Option<PathBuf>,
    /// The only way a development copy imports Ownkey's settings: from a copy of its config.json.
    pub import_ownkey: Option<PathBuf>,
}

pub const USAGE: &str = "Usage: rukoo-voice [--fake-engine[=<scenario>]] [--self-test <folder>] [--import-ownkey <copy of Ownkey's config.json>]";

pub fn parse(args: impl IntoIterator<Item = OsString>) -> Result<Args, String> {
    let mut out = Args::default();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let arg = arg
            .into_string()
            .map_err(|arg| format!("Unreadable argument {arg:?}"))?;
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) => (name.to_string(), Some(value.to_string())),
            None => (arg.clone(), None),
        };
        let mut value = |what: &str| -> Result<String, String> {
            let value = match inline.clone() {
                Some(value) => value,
                None => args
                    .next()
                    .and_then(|v| v.into_string().ok())
                    .ok_or_else(|| format!("{name} needs {what}"))?,
            };
            if value.is_empty() {
                return Err(format!("{name} needs {what}"));
            }
            Ok(value)
        };
        match name.as_str() {
            "--fake-engine" => {
                let scenario = inline.clone().unwrap_or_else(|| "idle".to_string());
                if scenario.is_empty() {
                    return Err("--fake-engine= needs a scenario".to_string());
                }
                out.fake_engine = Some(scenario);
            }
            "--self-test" => out.self_test = Some(PathBuf::from(value("a folder")?)),
            "--import-ownkey" => out.import_ownkey = Some(PathBuf::from(value("a path")?)),
            _ => return Err(format!("Unknown argument {arg}")),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(args: &[&str]) -> Result<Args, String> {
        parse(args.iter().map(OsString::from))
    }

    #[test]
    fn no_arguments_is_a_normal_start() {
        assert_eq!(run(&[]).unwrap(), Args::default());
    }

    #[test]
    fn fake_engine_takes_an_optional_scenario() {
        assert_eq!(
            run(&["--fake-engine"]).unwrap().fake_engine.as_deref(),
            Some("idle")
        );
        assert_eq!(
            run(&["--fake-engine=meeting"])
                .unwrap()
                .fake_engine
                .as_deref(),
            Some("meeting")
        );
        assert!(run(&["--fake-engine="]).is_err());
    }

    #[test]
    fn paths_come_after_a_space_or_an_equals_sign() {
        let args = run(&[
            "--self-test",
            "C:\\tmp\\shots",
            "--import-ownkey=C:\\tmp\\config.json",
        ])
        .unwrap();
        assert_eq!(args.self_test, Some(PathBuf::from("C:\\tmp\\shots")));
        assert_eq!(
            args.import_ownkey,
            Some(PathBuf::from("C:\\tmp\\config.json"))
        );
        assert!(run(&["--self-test"]).is_err());
        assert!(run(&["--import-ownkey="]).is_err());
    }

    #[test]
    fn unknown_arguments_are_refused() {
        assert!(run(&["--fake"]).is_err());
        assert!(run(&["settings"]).is_err());
    }
}
