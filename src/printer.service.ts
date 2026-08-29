import net from "net";
import axios from "axios";
import { Readable } from "stream";
import fs from "fs";
import path from "path";

const STORAGE_DIR = path.join(process.cwd(), "storage");

// Garante que a pasta de storage existe
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

/**
 * Remove arquivos antigos mantendo apenas os N mais recentes (padrão: 10)
 */
function rotateStorageFiles(storageDir: string, maxFiles: number = 10): void {
  try {
    if (!fs.existsSync(storageDir)) return;

    const files = fs
      .readdirSync(storageDir)
      .map((fileName) => {
        const filePath = path.join(storageDir, fileName);
        const stat = fs.statSync(filePath);
        return { fileName, filePath, mtime: stat.mtimeMs };
      })
      .filter((file) => fs.statSync(file.filePath).isFile());

    // Ordena do mais antigo para o mais recente
    files.sort((a, b) => a.mtime - b.mtime);

    if (files.length > maxFiles) {
      const filesToDelete = files.slice(0, files.length - maxFiles);
      for (const file of filesToDelete) {
        try {
          fs.unlinkSync(file.filePath);
          console.log(`🧽 Rotação de storage: removido PDF antigo ${file.fileName}`);
        } catch (err: any) {
          console.error(`⚠️ Erro ao remover PDF antigo ${file.fileName}:`, err.message);
        }
      }
    }
  } catch (error: any) {
    console.error("⚠️ Erro durante rotação dos arquivos de storage:", error.message);
  }
}

// Fila por IP de impressora para evitar conexões concorrentes no mesmo IP
const printerQueues: Map<string, Promise<void>> = new Map();

export async function sendToPrinter(
  fileUrl: string,
  printerIp: string,
  timeoutMs: number = 10000,
  reqId?: string | number
): Promise<{ success: boolean; error?: string; localFileName?: string }> {
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
    const result = await executePrintJob(fileUrl, printerIp, timeoutMs, reqId);
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
  timeoutMs: number,
  reqId?: string | number
): Promise<{ success: boolean; error?: string; localFileName?: string }> {
  try {
    const fileName = `print-${reqId ? `${reqId}-` : ""}${Date.now()}.pdf`;
    const localFilePath = path.join(STORAGE_DIR, fileName);

    // 1️⃣ Baixar e/ou salvar o arquivo localmente no storage
    if (fileUrl.startsWith("http://") || fileUrl.startsWith("https://")) {
      console.log(`🌐 Baixando PDF remoto para storage local: ${fileUrl}`);
      const response = await axios.get(fileUrl, {
        responseType: "stream",
        timeout: timeoutMs,
      });

      const writer = fs.createWriteStream(localFilePath);
      response.data.pipe(writer);

      await new Promise<void>((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
      });
    } else {
      if (!fs.existsSync(fileUrl)) {
        throw new Error(`Arquivo local não encontrado: ${fileUrl}`);
      }
      fs.copyFileSync(fileUrl, localFilePath);
    }

    console.log(`💾 PDF salvo localmente: ${fileName}`);

    // Executa a rotação de arquivos mantendo apenas os últimos 10
    rotateStorageFiles(STORAGE_DIR, 10);

    // 2️⃣ Enviar arquivo salvo via Socket TCP para a impressora
    const inputStream = fs.createReadStream(localFilePath);

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
        // Envia o caractere Form Feed (0x0C) para forçar o descarregamento do buffer de impressão imediatamente
        socket.write(Buffer.from([0x0c]), () => {
          socket.end();
        });
      });

      socket.on("finish", () => {
        console.log("✅ Dados totalmente transmitidos para o socket");
        // Força o fechamento da conexão TCP no Linux para a impressora não ficar aguardando no estado "Recebendo dados..."
        socket.destroy();
        resolve();
      });

      socket.on("close", (hadError) => {
        if (hadError) {
          reject(new Error("Conexão com a impressora foi encerrada com erro."));
        }
      });

      socket.on("error", (err) => {
        socket.destroy();
        reject(err);
      });
    });

    return { success: true, localFileName: fileName };
  } catch (error: any) {
    console.error("❌ Erro na impressão:", error.message);
    return { success: false, error: error.message };
  }
}


