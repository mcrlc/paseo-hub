// Holds one outbound WebSocket open and pings every 10s. Used by spike 1.
const log = (message) => process.stdout.write(`${new Date().toISOString()} ${message}\n`);
function connect() {
  const socket = new WebSocket("wss://echo.websocket.org");
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let timer;
  socket.addEventListener("open", () => {
    log("open");
    timer = setInterval(() => socket.send(`ping ${Date.now()}`), 10_000);
  });
  socket.addEventListener("message", (event) => log(`recv ${event.data}`));
  socket.addEventListener("error", (event) => log(`error ${event.message ?? ""}`));
  socket.addEventListener("close", () => {
    log("close");
    clearInterval(timer);
    setTimeout(connect, 5000);
  });
}
connect();
