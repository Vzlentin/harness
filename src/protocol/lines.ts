import type { Socket } from "node:net";

/** Calls `onLine` with each line that arrives on `socket`, without its newline. */
export function onLines(socket: Socket, onLine: (line: string) => void): void {
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffer += chunk;

		for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 1);
			onLine(line);
		}
	});
}
