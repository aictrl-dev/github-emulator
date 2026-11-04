export function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

export function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export function redirect(response, location) {
  response.writeHead(302, { location });
  response.end();
}
