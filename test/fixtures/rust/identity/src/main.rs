//! Prints one JSON line with what the program knows about its process: the bridge's identity and directory, wasi-libc's
//! directory after the bridge restored it, whether each standard stream is a terminal, and the contents of
//! `./identity.txt` when it exists. With one argument it also prints a prompt on stderr when stdin is a terminal.
use std::io::IsTerminal;

fn main() {
    let info = oxidevm_bridge::process::info();
    let field = |name: &str, value: String| format!("\"{name}\":{value}");
    let quoted = |text: &str| format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""));
    let mut fields = vec![];
    match info {
        Ok(info) => {
            fields.push(field("pid", info.pid.to_string()));
            fields.push(field(
                "parent",
                info.parent
                    .map_or_else(|| "null".into(), |pid| pid.to_string()),
            ));
            fields.push(field("uid", info.uid.to_string()));
            fields.push(field("gid", info.gid.to_string()));
        }
        Err(error) => fields.push(field("error", quoted(&error.to_string()))),
    }
    let bridge_cwd = oxidevm_bridge::process::cwd()
        .map_or_else(|error| error.to_string(), |path| path.display().to_string());
    fields.push(field("bridgeCwd", quoted(&bridge_cwd)));
    let std_cwd = std::env::current_dir()
        .map_or_else(|error| error.to_string(), |path| path.display().to_string());
    fields.push(field("stdCwd", quoted(&std_cwd)));
    let relative = std::fs::read_to_string("identity.txt").map_or_else(
        |error| format!("error: {}", error.kind()),
        |text| text.trim().to_string(),
    );
    fields.push(field("relative", quoted(&relative)));
    fields.push(field(
        "terminals",
        format!(
            "[{},{},{}]",
            std::io::stdin().is_terminal(),
            std::io::stdout().is_terminal(),
            std::io::stderr().is_terminal()
        ),
    ));
    println!("{{{}}}", fields.join(","));
    if std::env::args().len() > 1 && std::io::stdin().is_terminal() {
        eprint!("prompt> ");
    }
}
