// Erro com status HTTP, para as rotas avisarem o que deu errado.
// `extra` vai junto na resposta (ex.: a lista de conflitos de um bloqueio).
export class ErroHttp extends Error {
  constructor(status, mensagem, extra = undefined) {
    super(mensagem);
    this.status = status;
    this.extra = extra;
  }
}

// mensagens para as regras que o próprio banco garante
const SOBREPOSICAO = {
  reservas_sem_sobreposicao: [409, "Esse horário acabou de ser reservado. Escolha outro."],
  contratos_sem_sobreposicao: [409, "Já existe um mensalista nesse dia e horário."],
  funcionamento_sem_sobreposicao: [400, "Há turnos de funcionamento sobrepostos no mesmo dia."],
  faixas_preco_sem_sobreposicao: [400, "Há faixas de preço sobrepostas no mesmo dia."],
};

// Middleware final: transforma qualquer erro em resposta JSON, sem detalhes internos.
export function tratarErros(err, req, res, next) {
  // violação de uma constraint EXCLUDE (choque de horário)
  if (err.code === "23P01") {
    const [status, erro] = SOBREPOSICAO[err.constraint] ?? [409, "Esse horário não está disponível."];
    return res.status(status).json({ erro });
  }
  // JSON malformado no corpo da requisição
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ erro: "JSON inválido no corpo da requisição." });
  }
  // corpo maior que o limite do express.json
  if (err.type === "entity.too.large") {
    return res.status(413).json({ erro: "Pedido grande demais." });
  }
  if (err instanceof ErroHttp) {
    return res.status(err.status).json({ erro: err.message, ...err.extra });
  }
  // só o código e a mensagem: o objeto inteiro do pg pode trazer dados da linha (LGPD)
  console.error(`[erro] ${req.method} ${req.path}:`, err.code ?? "", err.message);
  res.status(500).json({ erro: "Erro interno do servidor." });
}
