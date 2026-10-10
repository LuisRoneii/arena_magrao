import "dotenv/config";
import { app } from "./app.js";

const porta = Number(process.env.PORT) || 3000;

app.listen(porta, () => {
  console.log(`API da Arena do Magrão rodando em http://localhost:${porta}`);
  console.log(`Teste: http://localhost:${porta}/api/saude`);
});
