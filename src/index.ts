import express from "express";
import path from "path";
import fs from "fs";
import { sendToPrinter } from "./printer.service";

const app = express();
app.use(express.json());

const STORAGE_DIR = path.join(process.cwd(), "storage");
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

// Servir arquivos de PDF salvos localmente
app.use("/storage", express.static(STORAGE_DIR));

app.get("/teste", async (req, res) => {
  res.status(200).json("API FUNCIONANDO");
});

app.post("/print", async (req, res) => {
  const { id_requisicao, tipo, printer_ip, file_url } = req.body;

  if (!id_requisicao || !printer_ip || !file_url)
    return res
      .status(400)
      .json({ success: false, error: "Parâmetros inválidos" });

  console.log(
    `🖨️ Pedido de impressão recebido: ${tipo} #${id_requisicao} → ${printer_ip}`
  );

  const result = await sendToPrinter(file_url, printer_ip, 10000, id_requisicao);

  const host = req.headers.host || `localhost:${process.env.PORT || 4005}`;
  const localUrl = result.localFileName
    ? `http://${host}/storage/${result.localFileName}`
    : undefined;

  if (localUrl) {
    console.log(`🔗 Link local do PDF: ${localUrl}`);
  }

  res.json({
    success: result.success,
    error: result.error,
    id_requisicao,
    tipo,
    local_url: localUrl,
  });
});

const PORT = process.env.PORT || 4005;
app.listen(PORT, () =>
  console.log(`🚀 Agente de Impressão rodando na porta ${PORT}`)
);

