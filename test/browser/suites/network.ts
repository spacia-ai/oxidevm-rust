// SL-07: Rust client streams to native VM services over TCP and Unix sockets.
import { exact, expect, sh, type Scenario } from "./support";

const ECHO = `import socket,sys,os
kind=sys.argv[1]
s=socket.socket(socket.AF_UNIX if kind=="unix" else socket.AF_INET)
s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
if kind=="unix":
    p=sys.argv[2]
    try: os.unlink(p)
    except FileNotFoundError: pass
    s.bind(p)
else: s.bind(("127.0.0.1",int(sys.argv[2])))
s.listen(4); open("ready-"+kind,"w").close()
for _ in range(int(sys.argv[3])):
    c,_=s.accept(); data=b""
    while True:
        b=c.recv(65536)
        if not b: break
        data+=b
    c.sendall(data.upper()); c.close()
`;
export const scenarios: readonly Scenario[] = [
  ["TCP to a native service with half-close (OBL-TCP)", async vm => {
    await vm.workspace.writeFile("t/echo.py", new TextEncoder().encode(ECHO));
    const run = await sh(vm, "rm -f ready-tcp; python3 echo.py tcp 7401 1 & while [ ! -e ready-tcp ]; do sleep 0.1; done; printf 'ping\\000bytes' | rust-bridge-demo connect tcp 127.0.0.1 7401 | od -An -c | tr -s ' '; wait");
    expect("tcp", run.status === "exit 0" && run.stdout.includes("P I N G \\0 B Y T E S"), run);
    return "binary request and reply over VM TCP";
  }],
  ["Unix socket service, missing and refused peers stay distinct (OBL-UNIX)", async vm => exact("unix",
    await sh(vm, "rm -f ready-unix; python3 echo.py unix /workspace/t/svc.sock 1 & while [ ! -e ready-unix ]; do sleep 0.1; done; echo q | rust-bridge-demo connect unix /workspace/t/svc.sock; wait; rust-bridge-demo connect unix /workspace/t/none.sock < /dev/null 2>&1 | cut -d: -f2; rust-bridge-demo connect unix /workspace/t/svc.sock < /dev/null 2>&1 | cut -d: -f2"),
    { status: 0, stdout: "Q\n NotFound\n ConnectionRefused\n", stderr: "" })],
  ["the base module has VM reach only (OBL-REACH)", async vm => {
    const run = await sh(vm, "rust-bridge-demo connect tcp 93.184.215.14 80 < /dev/null 2>&1 | cut -d: -f2");
    expect("reach", run.stdout.trim() === "PermissionDenied", run);
    return "an internet address is refused before any traffic";
  }],
];
