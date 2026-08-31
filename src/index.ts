import "dotenv/config";
import express, { Request, Response } from "express";
import { sendToPrinter } from "./printer.service";

const app = express();
app.use(express.json({ limit: "5mb" }));

app.get("/teste", (_req: Request, res: Response) => {
  res.status(200).json("API FUNCIONANDO");
});

app.post("/print", async (req: Request, res: Response) => {
  const { id_requisicao, tipo, printer_ip, file_url } = req.body ?? {};

  if (!id_requisicao || !printer_ip || !file_url) {
    res.status(400).json({ success: false, error: "Parâmetros inválidos" });
    return;
  }

  console.log(
    `🖨️ Pedido de impressão recebido: ${tipo} #${id_requisicao} → ${printer_ip}`
  );

  const result = await sendToPrinter(String(file_url), String(printer_ip));

  res.json({
    success: result.success,
    error: result.error ?? null,
    id_requisicao,
    tipo,
  });
});

const PORT = Number(process.env.PORT ?? 4005);
app.listen(PORT, () =>
  console.log(`🚀 Agente de Impressão rodando na porta ${PORT}`)
);
