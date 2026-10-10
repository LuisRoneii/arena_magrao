// Limites de uso: seguram quem tenta adivinhar senha ou código, ou lotar a agenda.
// A contagem é por IP e fica na memória da API (zera quando ela reinicia),
// o que basta para uma quadra. Com mais de um servidor, trocar por Redis.

import rateLimit from "express-rate-limit";

function limite({ janelaMin, maximo, mensagem, soFalhas = false }) {
  return rateLimit({
    windowMs: janelaMin * 60 * 1000,
    limit: maximo,
    standardHeaders: "draft-7",   // avisa o cliente quanto falta (RateLimit-*)
    legacyHeaders: false,
    skipSuccessfulRequests: soFalhas,
    // os testes automáticos desligam para não esbarrar no limite
    skip: () => process.env.LIMITES_DESLIGADOS === "1",
    handler: (req, res) => res.status(429).json({ erro: mensagem }),
  });
}

// login do painel: só as tentativas que falham contam
export const limiteLogin = limite({
  janelaMin: 15,
  maximo: 10,
  soFalhas: true,
  mensagem: "Muitas tentativas de login. Espere 15 minutos e tente de novo.",
});

// novas reservas pelo site. Folgado o bastante para vários jogadores reservarem
// pelo Wi-Fi da Arena (todos saem com o mesmo IP).
export const limiteReserva = limite({
  janelaMin: 60,
  maximo: 10,
  mensagem: "Muitas reservas seguidas. Tente de novo mais tarde ou chame a Arena no WhatsApp.",
});

// consultar e cancelar pelo código: segura quem tenta adivinhar códigos
export const limiteConsulta = limite({
  janelaMin: 15,
  maximo: 30,
  soFalhas: true,
  mensagem: "Muitas tentativas. Espere 15 minutos e confira o número e o código da reserva.",
});

// "Quero ser mensalista"
export const limiteSolicitacao = limite({
  janelaMin: 60,
  maximo: 5,
  mensagem: "Muitas solicitações seguidas. Tente de novo mais tarde ou chame a Arena no WhatsApp.",
});

// rede de segurança para o resto da API
export const limiteGeral = limite({
  janelaMin: 1,
  maximo: 120,
  mensagem: "Muitas requisições. Espere um minuto e tente de novo.",
});

// quantas solicitações de mensalista pendentes o mesmo WhatsApp pode ter
export const MAX_SOLICITACOES_PENDENTES = 2;
