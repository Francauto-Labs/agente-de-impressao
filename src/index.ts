import express from "express";
import { sendToPrinter } from "./printer.service";

const app = express();
app.use(express.json());

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

  const result = await sendToPrinter(file_url, printer_ip);
  res.json({
    success: result.success,
    error: result.error,
    id_requisicao,
    tipo,
  });
});

const PORT = process.env.PORT || 4005;
app.listen(PORT, () =>
  console.log(`🚀 Agente de Impressão rodando na porta ${PORT}`)
);
