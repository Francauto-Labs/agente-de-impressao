import net from "net";
import axios from "axios";
import { Readable } from "stream";
import fs from "fs";

// Fila por IP de impressora para evitar conexões concorrentes no mesmo IP
const printerQueues: Map<string, Promise<void>> = new Map();

export async function sendToPrinter(
  fileUrl: string,
  printerIp: string,
  timeoutMs: number = 10000
): Promise<{ success: boolean; error?: string }> {
  // Enfileira a impressão para a impressora específica para garantir ordem FIFO e evitar colisão de socket
  const previousTask = printerQueues.get(printerIp) || Promise.resolve();

  let resolveTask: () => void;
  const currentTask = new Promise<void>((resolve) => {
    resolveTask = resolve;
  });

  // Atualiza a fila da impressora
  printerQueues.set(
    printerIp,
    previousTask.then(() => currentTask).catch(() => currentTask)
  );

  await previousTask;

  try {
    const result = await executePrintJob(fileUrl, printerIp, timeoutMs);
    return result;
  } finally {
    resolveTask!();
    // Limpa a fila se não houver mais tarefas pendentes
    if (printerQueues.get(printerIp) === currentTask) {
      printerQueues.delete(printerIp);
    }
  }
}

async function executePrintJob(
  fileUrl: string,
  printerIp: string,
  timeoutMs: number
): Promise<{ success: boolean; error?: string }> {
  try {
    let inputStream: Readable;

    // 1️⃣ Obter o stream de dados (Stream HTTP remoto ou arquivo local)
    if (fileUrl.startsWith("http://") || fileUrl.startsWith("https://")) {
      console.log(`🌐 Baixando PDF via Stream: ${fileUrl}`);
      const response = await axios.get(fileUrl, {
        responseType: "stream",
        timeout: timeoutMs,
      });
      inputStream = response.data;
    } else {
      if (!fs.existsSync(fileUrl)) {
        throw new Error(`Arquivo local não encontrado: ${fileUrl}`);
      }
      inputStream = fs.createReadStream(fileUrl);
    }

    // 2️⃣ Enviar via Socket TCP diretamente com otimizaciones de rede
    await new Promise<void>((resolve, reject) => {
      const socket = new net.Socket();

      // Desativa o algoritmo de Nagle para transmissão imediata dos pacotes
      socket.setNoDelay(true);

      // Define timeout de conexão e transmissão
      socket.setTimeout(timeoutMs, () => {
        socket.destroy(
          new Error(`Timeout de comunicação (${timeoutMs}ms) com a impressora ${printerIp}`)
        );
      });

      socket.connect(9100, printerIp, () => {
        console.log(`📡 Conectado à impressora ${printerIp}`);
        inputStream.pipe(socket);
      });

      inputStream.on("end", () => {
        socket.end();
      });

      socket.on("close", (hadError) => {
        if (!hadError) {
          console.log("✅ Impressão enviada com sucesso");
          resolve();
        } else {
          reject(new Error("Conexão com a impressora foi encerrada com erro."));
        }
      });

      socket.on("error", (err) => {
        socket.destroy();
        reject(err);
      });
    });

    return { success: true };
  } catch (error: any) {
    console.error("❌ Erro na impressão:", error.message);
    return { success: false, error: error.message };
  }
}

