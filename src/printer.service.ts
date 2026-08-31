import express from "express";
import net from "net";
import axios from "axios";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";

/* =============================================================================
 * Configuração via ambiente (o POST não manda credenciais/modo)
 * ===========================================================================*/
const PORT = Number(process.env.PRINT_AGENT_PORT ?? 4005);
const PRINT_MODE = (process.env.PRINT_MODE ?? "pcl") as PrintMode; // raw|normalize|pcl|ps
const PRINT_COLOR = process.env.PRINT_COLOR === "true";
const GS_BIN = process.env.GHOSTSCRIPT_BIN ?? "gs";
const SMB_USER = process.env.SMB_USER ?? "";
const SMB_PASSWORD = process.env.SMB_PASSWORD ?? "";
const SMB_DOMAIN = process.env.SMB_DOMAIN ?? "";

type PrintMode = "raw" | "normalize" | "pcl" | "ps";

/* =============================================================================
 * Endpoint HTTP — recebe EXATAMENTE o que o seu serviço envia
 *   body: { id_requisicao, tipo, printer_ip, file_url }
 *   resp: { success: boolean, error?: string }
 * ===========================================================================*/
const app = express();
app.use(express.json({ limit: "5mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/print", async (req, res) => {
  const { id_requisicao, tipo, printer_ip, file_url } = req.body ?? {};

  if (!file_url || !printer_ip) {
    return res
      .status(400)
      .json({ success: false, error: "file_url e printer_ip são obrigatórios" });
  }

  console.log(`🖨️ Pedido recebido: ${tipo} #${id_requisicao} → ${printer_ip}`);

  const result = await sendToPrinter({
    fileUrl: file_url,
    destination: String(printer_ip),
  });

  // devolve no formato que o chamador espera (data.success / data.error)
  return res.json({ success: result.success, error: result.error });
});

app.listen(PORT, () => {
  console.log(`🚀 Print agent ouvindo na porta ${PORT} (modo=${PRINT_MODE})`);
});

/* =============================================================================
 * Núcleo de impressão
 * ===========================================================================*/
interface PrintJob {
  fileUrl: string;
  destination: string; // IP puro OU share (\\host\fila ou //host/fila)
}

const printerQueues: Map<string, Promise<void>> = new Map();

function sendToPrinter(job: PrintJob): Promise<{ success: boolean; error?: string }> {
  const key = job.destination;
  const prev = printerQueues.get(key) ?? Promise.resolve();
  const run = prev.then(() => executePrintJob(job), () => executePrintJob(job));
  const tracked: Promise<void> = run.then(() => {}, () => {});
  printerQueues.set(key, tracked);
  tracked.finally(() => {
    if (printerQueues.get(key) === tracked) printerQueues.delete(key);
  });
  return run;
}

function isShare(dest: string): boolean {
  return dest.startsWith("\\\\") || dest.startsWith("//");
}

function parseShare(dest: string) {
  const norm = dest.replace(/\\/g, "/").replace(/^\/+/, "//");
  const parts = norm.replace(/^\/\//, "").split("/");
  return { service: `//${parts[0]}/${parts[1]}` };
}

async function executePrintJob(job: PrintJob): Promise<{ success: boolean; error?: string }> {
  const { fileUrl, destination } = job;
  const tmpFiles: string[] = [];
  try {
    const pdfPath = await materializePdf(fileUrl, 30_000);
    tmpFiles.push(pdfPath);

    let toSend = pdfPath;
    if (PRINT_MODE !== "raw") {
      const out = await runGhostscript(GS_BIN, pdfPath, PRINT_MODE, PRINT_COLOR, 60_000);
      tmpFiles.push(out);
      toSend = out;
    }

    if (isShare(destination)) {
      await printViaSmb(toSend, destination);
    } else {
      await printViaSocket(await fsp.readFile(toSend), destination, 30_000);
    }
    return { success: true };
  } catch (error: any) {
    console.error(`❌ Erro na impressão (${destination}):`, error?.message ?? error);
    return { success: false, error: error?.message ?? String(error) };
  } finally {
    await Promise.all(tmpFiles.map((f) => fsp.unlink(f).catch(() => {})));
  }
}

/* ------------------------ Share Windows via smbclient ------------------------ */
function printViaSmb(filePath: string, destination: string): Promise<void> {
  const { service } = parseShare(destination);
  if (!SMB_USER) {
    return Promise.reject(
      new Error(`Impressão em share "${destination}" exige SMB_USER/SMB_PASSWORD no ambiente do agent.`)
    );
  }
  const args = [service, "-U", SMB_USER];
  if (SMB_DOMAIN) args.push("-W", SMB_DOMAIN);
  args.push("-c", `print "${filePath}"`);

  return new Promise<void>((resolve, reject) => {
    const proc = spawn("smbclient", args, { env: { ...process.env, PASSWD: SMB_PASSWORD } });
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`Timeout de impressão em ${service}`));
    }, 60_000);
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) =>
      reject(new Error(`Falha ao executar smbclient: ${err.message}. Instale: apt install smbclient`))
    );
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        console.log(`✅ Job enviado para a fila ${service}`);
        resolve();
      } else reject(new Error(`smbclient código ${code}: ${stderr}`));
    });
  });
}

/* --------------------------- IP puro via socket 9100 -------------------------- */
function printViaSocket(payload: Buffer, destination: string, timeoutMs: number): Promise<void> {
  const [ip, portStr] = destination.split(":");
  const port = portStr ? Number(portStr) : 9100;
  return new Promise<void>((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    let hadError = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };
    socket.setNoDelay(true);
    socket.setTimeout(timeoutMs, () =>
      fail(new Error(`Timeout de comunicação (${timeoutMs}ms) com ${ip}:${port}`))
    );
    socket.connect(port, ip, () => {
      console.log(`📡 Conectado à impressora ${ip}:${port}`);
      socket.end(payload);
    });
    socket.on("error", (err) => {
      hadError = true;
      fail(err);
    });
    socket.on("close", () => {
      if (settled) return;
      settled = true;
      if (hadError) reject(new Error("Conexão encerrada com erro."));
      else {
        console.log(`✅ Job transmitido para ${ip}:${port}`);
        resolve();
      }
    });
  });
}

/* -------------------------------- Utilitários -------------------------------- */
async function materializePdf(fileUrl: string, timeoutMs: number): Promise<string> {
  const dest = path.join(tmpdir(), `print-${randomUUID()}.pdf`);
  if (fileUrl.startsWith("http://") || fileUrl.startsWith("https://")) {
    const response = await axios.get(fileUrl, { responseType: "stream", timeout: timeoutMs });
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(dest);
      response.data.on("error", reject);
      out.on("error", reject);
      out.on("finish", () => resolve());
      response.data.pipe(out);
    });
  } else {
    if (!fs.existsSync(fileUrl)) throw new Error(`Arquivo local não encontrado: ${fileUrl}`);
    await fsp.copyFile(fileUrl, dest);
  }
  return dest;
}

function runGhostscript(
  bin: string,
  pdfPath: string,
  mode: "normalize" | "pcl" | "ps",
  color: boolean,
  timeoutMs: number
): Promise<string> {
  const outPath = path.join(tmpdir(), `print-${randomUUID()}.${mode === "normalize" ? "pdf" : "prn"}`);
  const device =
    mode === "normalize" ? "pdfwrite" : mode === "ps" ? "ps2write" : color ? "pxlcolor" : "pxlmono";
  const args = ["-dNOPAUSE", "-dBATCH", "-dSAFER", "-q", `-sDEVICE=${device}`];
  if (mode === "normalize") args.push("-dCompatibilityLevel=1.4", "-dPDFSETTINGS=/prepress");
  else args.push("-r600");
  args.push(`-sOutputFile=${outPath}`, pdfPath);

  return new Promise<string>((resolve, reject) => {
    const gs = spawn(bin, args);
    let stderr = "";
    const timer = setTimeout(() => {
      gs.kill("SIGKILL");
      reject(new Error(`Timeout na conversão Ghostscript (${timeoutMs}ms)`));
    }, timeoutMs);
    gs.stderr.on("data", (d) => (stderr += d.toString()));
    gs.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Falha ao executar Ghostscript ("${bin}"): ${err.message}. Instale: apt install ghostscript`));
    });
    gs.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(outPath);
      else reject(new Error(`Ghostscript código ${code}: ${stderr}`));
    });
  });
}