/**
 * The copy of images and Mermaid diagrams for `/vc` on macOS, Windows, WSL and Linux, and the system that it runs on:
 * the platform, the environment, the text clipboard and the runner of external programs.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";

/**
 * Runs `command` with `args` and gives its standard output. With `input`, the program reads that file as its standard
 * input, and the run waits for the exit of the program, not for the end of its output, and gives no output.
 */
export type Run = (command: string, args: readonly string[], input?: string) => Promise<string>;

/** What `/vc` takes from the system. Tests give their own, so they start no program and use no clipboard. */
export type System = {
	readonly platform: NodeJS.Platform;
	/** The release of the operating system, as `os.release()` gives it. */
	readonly release: string;
	readonly env: NodeJS.ProcessEnv;
	/** Puts the text on the clipboard. */
	readonly copyText: (text: string) => Promise<void>;
	readonly run: Run;
};

/** A run that failed, with the standard error of the program. */
export class RunError extends Error {
	readonly stderr: string;

	constructor(message: string, stderr: string) {
		super(message);
		this.stderr = stderr;
	}
}

/** A Mermaid code block. */
export type Diagram = { source: string };

/** An image that a tool result shows, with the file path when the tool read one. */
export type ImageRef = { data: string; mimeType: string; path?: string | undefined };

/** The system of this process: Node's platform, release and environment, Pi's clipboard and real programs. */
export const NODE_SYSTEM: System = {
	platform: process.platform,
	release: release(),
	env: process.env,
	copyText: copyToClipboard,
	run: runProgram,
};

async function runProgram(command: string, args: readonly string[], input?: string): Promise<string> {
	if (input !== undefined) {
		await runWithInput(command, args, input);

		return "";
	}

	try {
		return (await promisify(execFile)(command, args)).stdout;
	} catch (error) {
		if (!(error instanceof Error)) throw error;

		throw new RunError(error.message, "stderr" in error ? String(error.stderr) : "");
	}
}

/**
 * Runs the command with the file as its standard input. The clipboard tools stay in the background to serve the
 * clipboard, so this waits for the exit of the command, not for the end of its output.
 */
async function runWithInput(command: string, args: readonly string[], file: string): Promise<void> {
	const input = openSync(file, "r");

	try {
		await new Promise<void>((done, fail) => {
			const child = spawn(command, args, { stdio: [input, "ignore", "ignore"] });
			child.on("error", fail);
			child.on("exit", (code) => (code === 0 ? done() : fail(new Error(`${command} exited with code ${code}`))));
		});
	} finally {
		closeSync(input);
	}
}

// The diagram images are drawn at twice the size of the SVG, for sharp text on HiDPI screens.
const DIAGRAM_SCALE = 2;

// Puts the top left width x height pixels of a PNG file on the pasteboard.
const DIAGRAM_SCRIPT = `
ObjC.import("AppKit");
function run(argv) {
  const source = $.NSBitmapImageRep.imageRepWithData($.NSData.dataWithContentsOfFile(argv[0]));
  if (source.isNil()) throw new Error("Quick Look did not draw the diagram");
  const width = Number(argv[1]);
  const height = Number(argv[2]);
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
    null, width, height, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
  // Drawing coordinates start at the bottom left.
  source.drawInRectFromRectOperationFractionRespectFlippedHints($.NSMakeRect(0, 0, width, height),
    $.NSMakeRect(0, source.pixelsHigh - height, width, height), $.NSCompositingOperationCopy, 1, false, $());
  $.NSGraphicsContext.restoreGraphicsState;
  const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
  const board = $.NSPasteboard.generalPasteboard;
  board.clearContents;
  if (!board.setDataForType(png, $.NSPasteboardTypePNG)) throw new Error("the pasteboard did not accept the image");
  return width + "x" + height;
}`;

const IMAGE_SCRIPT = `
ObjC.import("AppKit");
function run(argv) {
  const data = $.NSData.dataWithContentsOfFile(argv[0]);
  const board = $.NSPasteboard.generalPasteboard;
  board.clearContents;
  const ok = argv[1] === "image/png"
    ? board.setDataForType(data, $.NSPasteboardTypePNG)
    : board.writeObjects($([$.NSImage.alloc.initWithData(data)]));
  if (!ok) throw new Error("the pasteboard did not accept the image");
}`;

// The Windows scripts get $InputFile. Windows PowerShell runs them in a single-threaded
// apartment, which the clipboard needs. Errors go to stderr as plain text, not as CLIXML.
const WINDOWS_PRELUDE = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
trap { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
`;

// Puts $bmp on the clipboard as a bitmap and as PNG, and writes its size.
const WINDOWS_CLIPBOARD = `
$png = New-Object System.IO.MemoryStream
$bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
$data = New-Object System.Windows.Forms.DataObject
$data.SetImage($bmp)
$data.SetData('PNG', $png)
[System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
"$($bmp.Width)x$($bmp.Height)"
`;

const WINDOWS_IMAGE_SCRIPT = `${WINDOWS_PRELUDE}
$bmp = [System.Drawing.Image]::FromFile($InputFile)
${WINDOWS_CLIPBOARD}`;

/**
 * Draws the diagram page $InputFile with headless Edge, which every Windows 10 and 11 has, and puts the screenshot on
 * the clipboard. Edge works in the Windows temporary folder, not in WSL, and its own profile keeps it apart from a
 * running Edge. It waits for the main Edge process only, because helper processes can stay.
 */
function windowsDiagramScript(width: number, height: number): string {
	return `${WINDOWS_PRELUDE}
$edge = @("\${env:ProgramFiles(x86)}\\Microsoft\\Edge\\Application\\msedge.exe", "$env:ProgramFiles\\Microsoft\\Edge\\Application\\msedge.exe") |
  Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $edge) { throw 'diagram copy on Windows requires Microsoft Edge' }
$dir = Join-Path $env:TEMP ('pi-vc-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $dir | Out-Null
try {
  $page = Join-Path $dir 'diagram.html'
  $shot = Join-Path $dir 'diagram.png'
  Copy-Item -LiteralPath $InputFile -Destination $page
  $arguments = @('--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    "--user-data-dir=""$(Join-Path $dir 'profile')""", '--window-size=${width},${height}',
    '--force-device-scale-factor=${DIAGRAM_SCALE}', "--screenshot=""$shot""", """$(([Uri]$page).AbsoluteUri)""")
  $process = Start-Process -FilePath $edge -ArgumentList $arguments -WindowStyle Hidden -PassThru
  if (-not $process.WaitForExit(60000)) { $process.Kill(); throw 'Edge did not draw the diagram in 60 s' }
  if (-not (Test-Path -LiteralPath $shot)) { throw 'Edge did not draw the diagram' }
  $bmp = [System.Drawing.Image]::FromFile($shot)
  try {
${WINDOWS_CLIPBOARD}
  } finally {
    $bmp.Dispose()
  }
} finally {
  Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
}
`;
}

const WSL_POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

/** The file extension of each image type. */
const EXTENSIONS = new Map([
	["image/png", "png"],
	["image/jpeg", "jpg"],
	["image/gif", "gif"],
	["image/webp", "webp"],
]);

const CSS_VAR = /var\((--[\w-]+)(?:,([^()]*))?\)/g;

/** The part of Pele that `/vc` uses. */
type Pele = { render(source: string, options: { padding: number }): { svg: string; width: number; height: number } };

/** Loads Pele from the global npm install, as the show-me skill does. */
async function loadPele(system: System): Promise<Pele> {
	const prefix = await system.run("npm", ["prefix", "-g"]);
	const dir = join(prefix.trim(), "lib", "node_modules", "pele");
	const entry = join(dir, "dist", "pele.js");

	if (!existsSync(entry)) throw new Error(`pele not found at ${dir}: npm install -g pele`);

	// SAFETY: the module is Pele's build, whose `render` gives the SVG and its size.
	return (await import(pathToFileURL(entry).href)) as Pele;
}

/** A diagram drawn as SVG, with its size. */
type Drawn = { svg: string; width: number; height: number };

/**
 * Draws the diagram as SVG with Pele. Pele colors the SVG with CSS variables and leaves the background transparent.
 * librsvg does not read CSS variables, so this puts the default Pele colors in their place and paints the background.
 */
async function renderMermaid(source: string, system: System): Promise<Drawn> {
	const { svg, width, height } = (await loadPele(system)).render(source, { padding: 16 });
	const opened = svg.indexOf(">") + 1;
	const style = /\sstyle="([^"]*)"/.exec(svg.slice(0, opened))?.[1] ?? "";
	const vars = new Map<string, string>();

	for (const declaration of style.split(/;(?![^(]*\))/)) {
		const [name = "", ...value] = declaration.split(":");

		if (name.trim().startsWith("--")) vars.set(name.trim(), value.join(":").trim());
	}

	const resolveVars = (text: string): string => {
		for (let last = ""; last !== text;) {
			last = text;
			text = text.replace(
				CSS_VAR,
				(all, name: string, fallback: string | undefined) => vars.get(name) ?? fallback?.trim() ?? all,
			);
		}

		return text;
	};

	for (const [name, value] of vars) vars.set(name, resolveVars(value));
	const background = vars.get("--_bg") ?? "#fff";
	const painted = `${svg.slice(0, opened)}<rect width="${width}" height="${height}" fill="${background}"/>${svg.slice(opened)}`;

	return { svg: resolveVars(painted), width, height };
}

/**
 * Draws the SVG with Quick Look, which uses WebKit. Quick Look draws a square thumbnail and scales tall images in its
 * own way, so the SVG gets a square canvas, and the script crops the diagram.
 */
async function copyMacDiagram(diagram: Drawn, dir: string, system: System): Promise<string> {
	const side = Math.max(diagram.width, diagram.height);
	const root = /viewBox="[^"]*" width="[^"]*" height="[^"]*"/;

	if (!root.test(diagram.svg)) throw new Error("Pele wrote no viewBox, width and height on the <svg>");
	const svg = join(dir, "diagram.svg");
	writeFileSync(svg, diagram.svg.replace(root, `viewBox="0 0 ${side} ${side}" width="${side}" height="${side}"`));
	await system.run("qlmanage", ["-t", "-s", String(side * DIAGRAM_SCALE), "-o", dir, svg]);
	const width = String(Math.ceil(diagram.width * DIAGRAM_SCALE));
	const height = String(Math.ceil(diagram.height * DIAGRAM_SCALE));
	const stdout = await system.run("osascript", ["-l", "JavaScript", "-e", DIAGRAM_SCRIPT, `${svg}.png`, width, height]);

	return stdout.trim();
}

/** Gives the system that puts images on the clipboard. WSL uses the Windows clipboard. */
function imageHost(system: System): "macos" | "windows" | "linux" {
	if (system.platform === "darwin") return "macos";

	if (system.platform === "win32" || (system.platform === "linux" && /microsoft/i.test(system.release)))
		return "windows";

	if (system.platform === "linux") return "linux";
	throw new Error("image copy requires macOS, Windows, WSL or Linux");
}

/** Gives the first of the commands that is on the PATH. */
function findCommand(system: System, ...names: string[]): string | undefined {
	const dirs = (system.env.PATH ?? "").split(delimiter).filter(Boolean);

	return names.find((name) => dirs.some((dir) => existsSync(join(dir, name))));
}

/** Converts an SVG file to a PNG file with librsvg or ImageMagick. */
async function svgToPng(svg: string, png: string, system: System): Promise<void> {
	const command = findCommand(system, "rsvg-convert", "magick", "convert");

	if (!command) throw new Error("diagram copy on Linux requires rsvg-convert (librsvg) or ImageMagick");

	if (command === "rsvg-convert") await system.run(command, ["-z", String(DIAGRAM_SCALE), "-f", "png", "-o", png, svg]);
	else await system.run(command, ["-density", String(96 * DIAGRAM_SCALE), svg, png]);
}

/** Puts the file on the Wayland or X11 clipboard. */
async function linuxClipboard(file: string, mimeType: string, system: System): Promise<void> {
	const wayland = system.env.WAYLAND_DISPLAY && findCommand(system, "wl-copy");
	const x11 = system.env.DISPLAY && findCommand(system, "xclip");

	if (!wayland && !x11) throw new Error("image copy on Linux requires wl-copy (wl-clipboard) or xclip");

	if (wayland) await system.run("wl-copy", ["--type", mimeType], file);
	else await system.run("xclip", ["-selection", "clipboard", "-target", mimeType], file);
}

/** Runs a Windows PowerShell script with $InputFile set to the Windows path of the file. */
async function powershell(script: string, file: string, system: System): Promise<string> {
	const wsl = system.platform === "linux";
	const path = wsl ? (await system.run("wslpath", ["-w", file])).trim() : file;
	const source = `$InputFile = '${path.replaceAll("'", "''")}'\n${script}`;
	const command = wsl && existsSync(WSL_POWERSHELL) ? WSL_POWERSHELL : "powershell.exe";
	const encoded = Buffer.from(source, "utf16le").toString("base64");

	try {
		const stdout = await system.run(command, ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded]);

		return stdout.trim();
	} catch (error) {
		const stderr = error instanceof RunError ? error.stderr.trim() : "";

		throw new Error(stderr || (error instanceof Error ? error.message : String(error)));
	}
}

/** Puts the diagram on the clipboard as an image, and gives its size in pixels, such as `640x480`. */
export async function copyDiagram(diagram: Diagram, system: System): Promise<string> {
	const host = imageHost(system);
	const rendered = await renderMermaid(diagram.source, system);
	const dir = mkdtempSync(join(tmpdir(), "pi-vc-diagram-"));

	try {
		if (host === "macos") return await copyMacDiagram(rendered, dir, system);

		if (host === "windows") {
			const page = join(dir, "diagram.html");
			writeFileSync(page, `<!doctype html><meta charset="utf-8"><body style="margin:0">${rendered.svg}</body>`);
			const script = windowsDiagramScript(Math.ceil(rendered.width), Math.ceil(rendered.height));

			return await powershell(script, page, system);
		}

		const svg = join(dir, "diagram.svg");
		const png = join(dir, "diagram.png");
		writeFileSync(svg, rendered.svg);
		await svgToPng(svg, png, system);
		await linuxClipboard(png, "image/png", system);

		return `${Math.ceil(rendered.width * DIAGRAM_SCALE)}x${Math.ceil(rendered.height * DIAGRAM_SCALE)}`;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Writes the image data to a temporary file, one file for each image, and gives its path. */
export function imageFile(image: ImageRef): string {
	const hash = createHash("sha256").update(image.data).digest("hex").slice(0, 16);
	const file = join(tmpdir(), `pi-vc-${hash}.${EXTENSIONS.get(image.mimeType) ?? "img"}`);

	if (!existsSync(file)) writeFileSync(file, Buffer.from(image.data, "base64"));

	return file;
}

/** Puts the image on the clipboard. */
export async function copyImage(image: ImageRef, system: System): Promise<void> {
	const host = imageHost(system);

	if (host === "windows") {
		await powershell(WINDOWS_IMAGE_SCRIPT, imageFile(image), system);

		return;
	}

	if (host === "linux") {
		await linuxClipboard(imageFile(image), image.mimeType, system);

		return;
	}

	await system.run("osascript", ["-l", "JavaScript", "-e", IMAGE_SCRIPT, imageFile(image), image.mimeType]);
}
