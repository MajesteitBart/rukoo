use std::io::Write;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Err(e) = voice_screen::run(&args) {
        let _ = writeln!(std::io::stderr(), "rukoo-voice-screen: {e}");
        std::process::exit(e.code);
    }
}
