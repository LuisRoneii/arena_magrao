/* ==========================================================================
   ARENA DO MAGRÃO — script.js (site público)
   Preços, contato e agenda vêm da API (pasta backend/). O cliente reserva só
   com nome e WhatsApp, sem conta e sem senha.
   "Hoje" vem sempre da API, no fuso da Arena: este arquivo nunca usa o relógio
   do aparelho para decidir datas.
   ========================================================================== */

(() => {
  "use strict";

  /* ---------------------------------------------------------------------
     Endereço da API
     Rodando no PC (Live Server na 5500): usa a API local na 3000.
     Publicado: a API fica em /api no mesmo domínio (Nginx).
  --------------------------------------------------------------------- */
  const SLUG = "arena-do-magrao";
  const API_LOCAL = `http://localhost:3000/api/${SLUG}`;
  const API_PRODUCAO = `/api/${SLUG}`;

  const ehLocal = ["localhost", "127.0.0.1", ""].includes(location.hostname);
  const API_URL = ehLocal ? API_LOCAL : API_PRODUCAO;

  const DIAS_POR_SEMANA = 7;
  const ORDEM_DIAS = [1, 2, 3, 4, 5, 6, 0]; // a semana começa na segunda
  const DIA_CURTO = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
  const DIA_LONGO = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

  const MSG_API_FORA =
    "Não foi possível falar com a Arena agora. Tente de novo em instantes ou chame no WhatsApp.";

  /* ---------------------------------------------------------------------
     Guardado neste aparelho (só conveniência, não é o banco)
     - nome e WhatsApp, para não digitar de novo
     - reservas feitas daqui (com o código), para "Minhas reservas"
  --------------------------------------------------------------------- */
  const LS_CLIENTE = "arena_cliente";
  const LS_RESERVAS = "arena_minhas_reservas";

  function lerLocal(chave, padrao) {
    try {
      const bruto = localStorage.getItem(chave);
      return bruto ? JSON.parse(bruto) : padrao;
    } catch (e) {
      return padrao;
    }
  }
  function gravarLocal(chave, valor) {
    try { localStorage.setItem(chave, JSON.stringify(valor)); } catch (e) { /* modo privado */ }
  }

  /* ---------------------------------------------------------------------
     Conversa com a API
  --------------------------------------------------------------------- */
  class ErroApi extends Error {
    constructor(mensagem, status) {
      super(mensagem);
      this.status = status;
    }
  }

  async function api(caminho, opcoes = {}) {
    let resposta;
    try {
      resposta = await fetch(API_URL + caminho, {
        headers: { "Content-Type": "application/json" },
        ...opcoes,
      });
    } catch (e) {
      throw new ErroApi(MSG_API_FORA, 0); // API desligada ou sem internet
    }
    const corpo = await resposta.json().catch(() => ({}));
    if (!resposta.ok) throw new ErroApi(corpo.erro || MSG_API_FORA, resposta.status);
    return corpo;
  }

  /* ---------------------------------------------------------------------
     Utilitários
  --------------------------------------------------------------------- */
  const $ = (id) => document.getElementById(id);

  // texto vindo da API ou do usuário vai sempre escapado, nunca direto no HTML
  function esc(texto) {
    return String(texto ?? "").replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  const preencher = (oQue) => `<span class="preencher">[PREENCHER: ${esc(oQue)}]</span>`;

  // dinheiro chega em centavos (inteiro); a divisão é só para exibir
  function formatarReais(centavos, { inteiro = false } = {}) {
    const casas = inteiro && centavos % 100 === 0 ? 0 : 2;
    return (centavos / 100).toLocaleString("pt-BR", {
      style: "currency", currency: "BRL", minimumFractionDigits: casas, maximumFractionDigits: casas,
    });
  }

  // 0 centavos = preço ainda não configurado pela Arena
  const valorOuPreencher = (centavos, oQue, opcoes) =>
    (centavos > 0 ? esc(formatarReais(centavos, opcoes)) : preencher(oQue));

  // datas "AAAA-MM-DD": só aritmética de calendário (UTC), a partir do "hoje" da API
  function somarDias(iso, n) {
    const [a, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
  }
  function diasEntre(de, ate) {
    const ms = (iso) => { const [a, m, d] = iso.split("-").map(Number); return Date.UTC(a, m - 1, d); };
    return Math.round((ms(ate) - ms(de)) / 86400000);
  }
  const diaDaSemana = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay();
  const diaMes = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
  const dataCompleta = (iso) => `${diaMes(iso)}/${iso.slice(0, 4)}`;

  // 90 -> "1h30"
  function formatarDuracao(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (!h) return `${m} min`;
    return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
  }

  // "17:00" -> "17h", "17:30" -> "17h30"
  function horaCurta(hhmm) {
    const [h, m] = hhmm.split(":");
    return m === "00" ? `${Number(h)}h` : `${Number(h)}h${m}`;
  }

  const paraMinutos = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
  const paraHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

  // [1,2,3,4,5] -> "seg a sex"; [6,0] -> "sáb e dom"; [1,3] -> "seg, qua"
  function juntarDias(dias) {
    const posicoes = dias.map((d) => ORDEM_DIAS.indexOf(d)).sort((a, b) => a - b);
    const grupos = [];
    for (const p of posicoes) {
      const ultimo = grupos[grupos.length - 1];
      if (ultimo && p === ultimo[ultimo.length - 1] + 1) ultimo.push(p);
      else grupos.push([p]);
    }
    const nome = (p) => DIA_CURTO[ORDEM_DIAS[p]];
    return grupos.map((g) => {
      if (g.length === 1) return nome(g[0]);
      if (g.length === 2) return `${nome(g[0])} e ${nome(g[1])}`;
      return `${nome(g[0])} a ${nome(g[g.length - 1])}`;
    }).join(", ");
  }
  const maiuscula = (t) => t.charAt(0).toUpperCase() + t.slice(1);

  // agrupa itens por um texto-chave e devolve os dias de cada grupo
  function agruparPorDias(itens, chave) {
    const grupos = new Map();
    const naSemana = (item) => ORDEM_DIAS.indexOf(item.dia_semana); // segunda primeiro
    for (const item of [...itens].sort((a, b) => naSemana(a) - naSemana(b))) {
      const k = chave(item);
      if (!grupos.has(k)) grupos.set(k, { item, dias: [] });
      grupos.get(k).dias.push(item.dia_semana);
    }
    return [...grupos.values()];
  }

  function mostrarMsg(el, texto, erro) {
    el.textContent = texto;
    el.classList.toggle("is-erro", !!erro);
    el.classList.toggle("is-ok", !erro);
  }

  // (47) 99999-0000 enquanto digita; o servidor valida de verdade
  function mascararTelefone(valor) {
    let d = valor.replace(/\D/g, "");
    if (d.length > 11 && d.startsWith("55")) d = d.slice(2);
    d = d.slice(0, 11);
    if (d.length <= 2) return d ? `(${d}` : "";
    if (d.length <= 7) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  }
  document.querySelectorAll('input[type="tel"]').forEach((input) => {
    input.addEventListener("input", () => { input.value = mascararTelefone(input.value); });
  });

  /* ---------------------------------------------------------------------
     Menu do celular
  --------------------------------------------------------------------- */
  const hamburguer = $("hamburguer");
  const menuCelular = $("menu-celular");

  function fecharMenu() {
    menuCelular.classList.remove("is-aberto");
    hamburguer.setAttribute("aria-expanded", "false");
    hamburguer.setAttribute("aria-label", "Abrir menu");
  }
  hamburguer.addEventListener("click", () => {
    const aberto = menuCelular.classList.toggle("is-aberto");
    hamburguer.setAttribute("aria-expanded", String(aberto));
    hamburguer.setAttribute("aria-label", aberto ? "Fechar menu" : "Abrir menu");
  });
  menuCelular.querySelectorAll("a").forEach((a) => a.addEventListener("click", fecharMenu));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menuCelular.classList.contains("is-aberto")) {
      fecharMenu();
      hamburguer.focus();
    }
  });

  /* ---------------------------------------------------------------------
     Dados da Arena (/info): preços, contato e funcionamento
  --------------------------------------------------------------------- */
  let INFO = null;

  // wa.me exige DDI + DDD + número
  function linkWhatsapp(texto) {
    if (!INFO?.whatsapp) return null;
    return `https://wa.me/55${INFO.whatsapp}?text=${encodeURIComponent(texto)}`;
  }

  function formatarTelefone(d) {
    return d.length === 11
      ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`
      : `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  }

  // "Seg a sex, 17h às 19h" para cada grupo de faixas (normal ou nobre)
  function renderizarCardPreco(faixas, idQuando, idValor, nomeFaixa) {
    const quando = $(idQuando);
    const valor = $(idValor);
    if (!faixas.length) {
      quando.textContent = "Sem horários nesta faixa.";
      valor.textContent = "";
      return;
    }
    quando.innerHTML = agruparPorDias(faixas, (f) => `${f.inicio}-${f.fim}`)
      .map(({ item, dias }) => esc(`${maiuscula(juntarDias(dias))}, ${horaCurta(item.inicio)} às ${horaCurta(item.fim)}`))
      .join("<br>");

    const precos = faixas.map((f) => f.preco_hora_centavos);
    const menor = Math.min(...precos);
    if (menor <= 0) {
      valor.innerHTML = preencher(`preço por hora, ${nomeFaixa}`);
      return;
    }
    const prefixo = precos.some((p) => p !== menor) ? "<small>a partir de</small> " : "";
    valor.innerHTML = `${prefixo}${esc(formatarReais(menor, { inteiro: true }))}<small>/hora</small>`;
  }

  function renderizarPrecos() {
    const faixas = INFO.faixas_preco;
    renderizarCardPreco(faixas.filter((f) => !f.nobre), "preco-normal-quando", "preco-normal-valor", "horário normal");
    renderizarCardPreco(faixas.filter((f) => f.nobre), "preco-nobre-quando", "preco-nobre-valor", "horário nobre");

    const mensal = INFO.mensalidade_padrao_centavos;
    $("preco-mensal-valor").innerHTML = mensal > 0
      ? `${esc(formatarReais(mensal, { inteiro: true }))}<small>/mês</small>`
      : preencher("valor da mensalidade");

    const duracoes = INFO.duracoes_permitidas.map(formatarDuracao);
    $("precos-sub").textContent =
      `O valor é por hora e depende do dia e do horário. Dá para reservar ${duracoes.slice(0, -1).join(", ")}` +
      `${duracoes.length > 1 ? " ou " : ""}${duracoes[duracoes.length - 1]}, e na reserva você já vê o total antes de confirmar.`;
  }

  function renderizarContato() {
    if (INFO.endereco) $("contato-endereco").textContent = INFO.endereco;
    if (INFO.link_mapa) {
      // a API só aceita link https:// (validado no painel)
      $("contato-mapa").innerHTML =
        `<a href="${esc(INFO.link_mapa)}" target="_blank" rel="noopener">Abrir no Google Maps</a>`;
    }
    if (INFO.whatsapp) {
      $("contato-whatsapp").innerHTML =
        `<a href="${esc(linkWhatsapp("Olá! Vim pelo site da Arena do Magrão."))}" target="_blank" rel="noopener">${esc(formatarTelefone(INFO.whatsapp))}</a>`;
    }
    if (INFO.instagram) {
      document.querySelectorAll('a[href^="https://www.instagram.com/"]').forEach((a) => {
        a.href = `https://www.instagram.com/${encodeURIComponent(INFO.instagram)}/`;
        if (a.textContent.startsWith("@")) a.textContent = `@${INFO.instagram}`;
      });
    }
    // botões "WhatsApp" com mensagem pronta (data-whatsapp)
    document.querySelectorAll("[data-whatsapp]").forEach((a) => {
      const link = linkWhatsapp(a.dataset.whatsapp);
      if (link) {
        a.href = link;
        a.target = "_blank";
        a.rel = "noopener";
      }
    });

    // funcionamento: "Seg a sex: 17h às 23h"; dias sem turno aparecem como fechado
    const ul = $("contato-funcionamento");
    const abertos = new Set(INFO.funcionamento.map((t) => t.dia_semana));
    const porDia = ORDEM_DIAS.filter((d) => abertos.has(d)).map((d) => ({
      dia_semana: d,
      texto: INFO.funcionamento.filter((t) => t.dia_semana === d)
        .map((t) => `${horaCurta(t.inicio)} às ${horaCurta(t.fim)}`).join(" e "),
    }));
    const linhas = agruparPorDias(porDia, (d) => d.texto)
      .map(({ item, dias }) => `${maiuscula(juntarDias(dias))}: ${item.texto}`);
    const fechados = ORDEM_DIAS.filter((d) => !abertos.has(d));
    if (fechados.length) linhas.push(`${maiuscula(juntarDias(fechados))}: fechado`);
    ul.innerHTML = linhas.map((l) => `<li>${esc(l)}</li>`).join("");
  }

  /* ---------------------------------------------------------------------
     Agenda: duração -> semana -> dia -> horário -> dados -> confirmação
  --------------------------------------------------------------------- */
  const estado = {
    duracao: null,
    inicio: null,      // primeiro dia da semana mostrada ("AAAA-MM-DD")
    dias: [],          // resposta de /agenda
    dataSel: null,
    horarioSel: null,  // item de "livres": { horario, fim, valor_centavos, nobre }
  };
  let carregandoSemana = 0; // descarta respostas antigas se a pessoa clicar rápido

  const elHorarios = $("horarios");
  const msgAgenda = $("msg-agenda");
  const formReserva = $("form-reserva");
  const msgReserva = $("msg-reserva");
  const btnReservar = $("btn-reservar");
  const inputNome = $("reserva-nome");
  const inputTelefone = $("reserva-telefone");
  const inputAceite = $("reserva-aceite");

  /* Remarcar: vindo de "Minhas reservas" com index.html?remarcar=ID#agendar.
     O código da reserva não vai na URL: fica guardado neste aparelho. */
  const parametros = new URLSearchParams(location.search);
  let remarcando = lerLocal(LS_RESERVAS, [])
    .find((r) => r.id === Number(parametros.get("remarcar")) && r.codigo) || null;

  function renderizarDuracoes() {
    const caixa = $("duracoes");
    caixa.innerHTML = "";
    INFO.duracoes_permitidas.forEach((min) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = formatarDuracao(min);
      btn.setAttribute("aria-pressed", String(min === estado.duracao));
      btn.addEventListener("click", () => {
        if (min === estado.duracao) return;
        estado.duracao = min;
        caixa.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
        carregarSemana();
      });
      caixa.appendChild(btn);
    });
  }

  function atualizarSetas() {
    $("semana-anterior").disabled = estado.inicio <= INFO.hoje;
    // a próxima semana só abre se tiver pelo menos um dia dentro da janela de reserva
    $("semana-proxima").disabled =
      diasEntre(INFO.hoje, somarDias(estado.inicio, DIAS_POR_SEMANA)) > INFO.janela_reserva_dias;
    const fim = somarDias(estado.inicio, DIAS_POR_SEMANA - 1);
    $("semana-titulo").textContent = `${diaMes(estado.inicio)} a ${diaMes(fim)}`;
  }

  $("semana-anterior").addEventListener("click", () => {
    const anterior = somarDias(estado.inicio, -DIAS_POR_SEMANA);
    estado.inicio = anterior < INFO.hoje ? INFO.hoje : anterior;
    carregarSemana();
  });
  $("semana-proxima").addEventListener("click", () => {
    estado.inicio = somarDias(estado.inicio, DIAS_POR_SEMANA);
    carregarSemana();
  });

  function avisoNaLista(ul, texto) {
    ul.innerHTML = "";
    const li = document.createElement("li");
    li.className = "horarios__aviso";
    li.textContent = texto;
    ul.appendChild(li);
  }

  async function carregarSemana() {
    const pedido = ++carregandoSemana;
    atualizarSetas();
    esconderFormulario();
    msgAgenda.textContent = "";
    avisoNaLista(elHorarios, "Carregando horários…");

    let resposta;
    try {
      resposta = await api(`/agenda?inicio=${estado.inicio}&dias=${DIAS_POR_SEMANA}&duracao=${estado.duracao}`);
    } catch (e) {
      if (pedido !== carregandoSemana) return;
      elHorarios.innerHTML = "";
      $("dias").innerHTML = "";
      mostrarMsg(msgAgenda, e.message, true);
      return;
    }
    if (pedido !== carregandoSemana) return;

    estado.dias = resposta.dias;
    const aindaAberto = estado.dias.find((d) => d.data === estado.dataSel && d.situacao === "aberto");
    estado.dataSel = aindaAberto ? aindaAberto.data : (estado.dias.find((d) => d.situacao === "aberto")?.data ?? null);
    renderizarDias();
    renderizarHorarios();
  }

  const SITUACAO = {
    lotado: "Lotado",
    fechado: "Fechado",
    passado: "Passou",
    fora_da_janela: "Em breve",
  };

  function renderizarDias() {
    const ul = $("dias");
    ul.innerHTML = "";
    estado.dias.forEach((d) => {
      const livres = d.livres.length;
      const situacao = d.situacao === "aberto"
        ? `${livres} ${livres === 1 ? "livre" : "livres"}`
        : SITUACAO[d.situacao] || "";
      const nomeDia = d.data === INFO.hoje ? "Hoje" : DIA_CURTO[d.dia_semana];

      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dia";
      btn.disabled = d.situacao !== "aberto";
      btn.setAttribute("aria-pressed", String(d.data === estado.dataSel));
      btn.setAttribute("aria-label", `${DIA_LONGO[d.dia_semana]}, ${diaMes(d.data)}: ${situacao}`);
      btn.innerHTML = `
        <span class="dia__semana">${esc(nomeDia)}</span>
        <span class="dia__numero">${esc(diaMes(d.data))}</span>
        <span class="dia__situacao">${esc(situacao)}</span>`;
      btn.addEventListener("click", () => {
        estado.dataSel = d.data;
        ul.querySelectorAll(".dia").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
        esconderFormulario();
        renderizarHorarios();
      });
      li.appendChild(btn);
      ul.appendChild(li);
    });
  }

  function renderizarHorarios() {
    const dia = estado.dias.find((d) => d.data === estado.dataSel);
    if (!dia) {
      avisoNaLista(elHorarios, $("semana-proxima").disabled
        ? "Não há horários livres nos próximos dias. Chame a Arena no WhatsApp."
        : "Nenhum dia com horário livre nesta semana. Veja a próxima semana.");
      return;
    }

    // livres e ocupados na mesma lista, em ordem de horário (ocupado não diz de quem é)
    const itens = [
      ...dia.livres.map((l) => ({ tipo: "livre", inicio: l.horario, livre: l })),
      ...dia.ocupados.map((o) => ({ tipo: "ocupado", inicio: o.inicio, fim: o.fim })),
    ].sort((a, b) => a.inicio.localeCompare(b.inicio) || (a.tipo === "ocupado" ? -1 : 1));

    elHorarios.innerHTML = "";
    itens.forEach((item) => {
      const li = document.createElement("li");
      if (item.tipo === "ocupado") {
        li.className = "horarios__ocupado";
        li.innerHTML = `
          <div class="horario horario--ocupado">
            <span class="placar">${esc(item.inicio)}–${esc(item.fim)}</span>
            <span class="horario__info">Ocupado</span>
          </div>`;
      } else {
        const l = item.livre;
        const valor = l.valor_centavos > 0 ? formatarReais(l.valor_centavos) : null;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `horario${l.nobre ? " horario--nobre" : ""}`;
        btn.setAttribute("aria-pressed", "false");
        btn.setAttribute("aria-label",
          `${l.horario} às ${l.fim}${valor ? `, ${valor}` : ""}${l.nobre ? ", horário nobre" : ""}`);
        btn.innerHTML = `
          <span class="placar">${esc(l.horario)}</span>
          <span class="horario__info">até ${esc(l.fim)}${l.nobre ? ' <span class="selo-nobre">nobre</span>' : ""}</span>
          ${valor ? `<span class="horario__info"><span class="horario__valor">${esc(valor)}</span></span>` : ""}`;
        btn.addEventListener("click", () => {
          elHorarios.querySelectorAll(".horario[aria-pressed]").forEach((b) => b.setAttribute("aria-pressed", "false"));
          btn.setAttribute("aria-pressed", "true");
          escolherHorario(l);
        });
        li.appendChild(btn);
      }
      elHorarios.appendChild(li);
    });
  }

  function descricaoHorario(data, horario, fim, duracao) {
    return `${maiuscula(DIA_LONGO[diaDaSemana(data)])}, ${diaMes(data)}, das ${horario} às ${fim} (${formatarDuracao(duracao)})`;
  }

  function escolherHorario(livre) {
    estado.horarioSel = livre;
    $("resumo").innerHTML =
      `<strong>${esc(descricaoHorario(estado.dataSel, livre.horario, livre.fim, estado.duracao))}</strong><br>` +
      `Valor: ${valorOuPreencher(livre.valor_centavos, "preço")}${livre.nobre ? " · horário nobre" : ""}` +
      " · pagamento direto com a Arena (Pix ou no local)";
    formReserva.classList.remove("hidden");
    msgReserva.textContent = "";

    const salvo = lerLocal(LS_CLIENTE, null);
    if (salvo && !inputNome.value) inputNome.value = salvo.nome || "";
    if (salvo && !inputTelefone.value) inputTelefone.value = mascararTelefone(salvo.telefone || "");

    formReserva.scrollIntoView({ behavior: "smooth", block: "nearest" });
    (inputNome.value ? inputTelefone : inputNome).focus({ preventScroll: true });
  }

  function esconderFormulario() {
    estado.horarioSel = null;
    formReserva.classList.add("hidden");
    msgReserva.textContent = "";
  }

  // marcou o aceite depois do aviso: o aviso some
  inputAceite.addEventListener("change", () => { if (inputAceite.checked) msgReserva.textContent = ""; });
  $("mensal-aceite").addEventListener("change", (e) => { if (e.target.checked) $("msg-mensalista").textContent = ""; });

  formReserva.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!estado.horarioSel) {
      mostrarMsg(msgReserva, "Escolha um horário antes de confirmar.", true);
      return;
    }
    const nome = inputNome.value.trim();
    const telefone = inputTelefone.value.replace(/\D/g, "");
    if (nome.length < 2) {
      mostrarMsg(msgReserva, "Informe seu nome.", true);
      inputNome.focus();
      return;
    }
    if (telefone.length < 10) {
      mostrarMsg(msgReserva, "Informe seu WhatsApp com DDD.", true);
      inputTelefone.focus();
      return;
    }
    if (!inputAceite.checked) {
      mostrarMsg(msgReserva, "Para reservar, marque que aceita a política de privacidade.", true);
      inputAceite.focus();
      return;
    }

    btnReservar.disabled = true;
    btnReservar.textContent = "Confirmando…";
    try {
      const criada = await api("/reservas", {
        method: "POST",
        body: JSON.stringify({
          data: estado.dataSel,
          horario: estado.horarioSel.horario,
          duracao_min: estado.duracao,
          nome,
          telefone,
          aceite_privacidade: true,
          // remarcar: a API cancela a antiga na mesma transação
          remarcar: remarcando ? { id: remarcando.id, codigo: remarcando.codigo } : undefined,
        }),
      });

      gravarLocal(LS_CLIENTE, { nome, telefone });
      // remarcou: a antiga sai da lista deste aparelho
      const minhas = lerLocal(LS_RESERVAS, []).filter((r) => !remarcando || r.id !== remarcando.id);
      minhas.push({
        id: criada.id,
        codigo: criada.codigo,
        data: criada.data,
        horario: criada.horario,
        fim: criada.fim,
        duracao_min: criada.duracao_min,
        valor_centavos: criada.valor_centavos,
      });
      gravarLocal(LS_RESERVAS, minhas);

      const foiRemarcada = !!remarcando;
      remarcando = null;
      $("aviso-remarcar").classList.add("hidden");
      history.replaceState(null, "", location.pathname + "#agendar"); // tira o ?remarcar da URL

      mostrarConfirmacao(criada, nome, foiRemarcada);
    } catch (erro) {
      // alguém pegou o horário: recarrega a semana (ela limpa a mensagem) e avisa
      if (erro.status === 409) await carregarSemana();
      mostrarMsg(erro.status === 409 ? msgAgenda : msgReserva, erro.message, true);
    } finally {
      btnReservar.disabled = false;
      btnReservar.textContent = "Confirmar reserva";
    }
  });

  /* Confirmação: número + código, resumo, valor e o botão do WhatsApp */
  function mostrarConfirmacao(r, nome, foiRemarcada) {
    const codigoCurto = r.codigo.replace(/-/g, "");
    const pasta = location.pathname.replace(/[^/]*$/, "");
    const linkConsulta = `${location.origin}${pasta}meus-agendamentos.html#${r.id}-${codigoCurto}`;
    const horario = descricaoHorario(r.data, r.horario, r.fim, r.duracao_min);

    $("confirmado-titulo").textContent = foiRemarcada ? "Reserva remarcada!" : "Reserva confirmada!";
    $("confirmado-codigo").textContent = `Nº ${r.id} · ${r.codigo}`;
    $("confirmado-dados").innerHTML = `
      <dt>Dia</dt><dd>${esc(`${maiuscula(DIA_LONGO[diaDaSemana(r.data)])}, ${dataCompleta(r.data)}`)}</dd>
      <dt>Horário</dt><dd>${esc(`${r.horario} às ${r.fim} (${formatarDuracao(r.duracao_min)})`)}</dd>
      <dt>Valor</dt><dd>${valorOuPreencher(r.valor_centavos, "preço")}</dd>
      <dt>Pagamento</dt><dd>Direto com a Arena: Pix ou no local${INFO.pix_chave ? `<br>Chave Pix: ${esc(INFO.pix_chave)}` : ""}</dd>`;
    $("confirmado-nota").textContent =
      "Guarde o número e o código: com eles você consulta, cancela ou remarca em Minhas reservas, " +
      `até ${INFO.antecedencia_cancelamento_horas} horas antes. Neste aparelho eles já ficam salvos.`;

    const btnWhats = $("btn-whatsapp-reserva");
    const link = linkWhatsapp([
      foiRemarcada ? "Olá! Remarquei minha reserva pelo site da Arena do Magrão." : "Olá! Fiz uma reserva pelo site da Arena do Magrão.",
      `Reserva Nº ${r.id} · Código ${r.codigo}`,
      horario,
      r.valor_centavos > 0 ? `Valor: ${formatarReais(r.valor_centavos)}` : null,
      `Nome: ${nome}`,
      `Ver a reserva: ${linkConsulta}`,
    ].filter(Boolean).join("\n"));
    btnWhats.classList.toggle("hidden", !link);
    $("sem-whatsapp-reserva").classList.toggle("hidden", !!link);
    if (link) btnWhats.href = link;

    $("agenda-escolha").classList.add("hidden");
    const caixa = $("confirmado");
    caixa.classList.remove("hidden");
    // leitor de tela anuncia; a rolagem mostra a confirmação desde o topo
    caixa.focus({ preventScroll: true });
    caixa.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  $("btn-nova-reserva").addEventListener("click", () => {
    $("confirmado").classList.add("hidden");
    $("agenda-escolha").classList.remove("hidden");
    inputAceite.checked = false;
    carregarSemana();
    $("agendar").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  function iniciarRemarcar() {
    if (!remarcando) return;
    if (INFO.duracoes_permitidas.includes(remarcando.duracao_min)) estado.duracao = remarcando.duracao_min;
    const aviso = $("aviso-remarcar");
    aviso.innerHTML =
      `Remarcando a reserva <strong>Nº ${esc(remarcando.id)}</strong> de ` +
      `<strong>${esc(`${diaMes(remarcando.data)} às ${remarcando.horario}`)}</strong>. ` +
      'Ao confirmar o novo horário, a reserva antiga é cancelada. <a href="index.html#agendar">Desistir</a>';
    aviso.classList.remove("hidden");
  }

  /* ---------------------------------------------------------------------
     Quero ser mensalista
  --------------------------------------------------------------------- */
  const formMensal = $("form-mensalista");
  const selDia = $("mensal-dia");
  const selDuracao = $("mensal-duracao");
  const selHorario = $("mensal-horario");
  const msgMensal = $("msg-mensalista");

  function opcao(valor, texto) {
    const o = document.createElement("option");
    o.value = valor;
    o.textContent = texto;
    return o;
  }

  function prepararFormMensalista() {
    const abertos = new Set(INFO.funcionamento.map((t) => t.dia_semana));
    selDia.replaceChildren(opcao("", "Escolha"),
      ...ORDEM_DIAS.filter((d) => abertos.has(d)).map((d) => opcao(d, maiuscula(DIA_LONGO[d]))));
    selDuracao.replaceChildren(...INFO.duracoes_permitidas.map((m) => opcao(m, formatarDuracao(m))));
    atualizarHorariosMensal();
  }

  // horários de início que cabem no funcionamento do dia, com a duração escolhida
  function atualizarHorariosMensal() {
    const anterior = selHorario.value;
    if (selDia.value === "") {
      selHorario.replaceChildren(opcao("", "Escolha o dia primeiro"));
      return;
    }
    const dia = Number(selDia.value);
    const duracao = Number(selDuracao.value);
    const opcoes = [];
    INFO.funcionamento.filter((t) => t.dia_semana === dia).forEach((t) => {
      for (let m = paraMinutos(t.inicio); m + duracao <= paraMinutos(t.fim); m += INFO.intervalo_grade_min) {
        opcoes.push(paraHHMM(m));
      }
    });
    selHorario.replaceChildren(opcao("", "Escolha"), ...opcoes.map((h) => opcao(h, h)));
    if (opcoes.includes(anterior)) selHorario.value = anterior;
  }
  selDia.addEventListener("change", atualizarHorariosMensal);
  selDuracao.addEventListener("change", atualizarHorariosMensal);

  formMensal.addEventListener("submit", async (e) => {
    e.preventDefault();
    const nome = $("mensal-nome").value.trim();
    const telefone = $("mensal-telefone").value.replace(/\D/g, "");
    const erros = [
      [nome.length < 2, "Informe seu nome.", $("mensal-nome")],
      [telefone.length < 10, "Informe seu WhatsApp com DDD.", $("mensal-telefone")],
      [selDia.value === "", "Escolha o dia da semana.", selDia],
      [selHorario.value === "", "Escolha o horário de início.", selHorario],
      [!$("mensal-aceite").checked, "Para enviar, marque que aceita a política de privacidade.", $("mensal-aceite")],
    ];
    const erro = erros.find(([falhou]) => falhou);
    if (erro) {
      mostrarMsg(msgMensal, erro[1], true);
      erro[2].focus();
      return;
    }

    const btn = $("btn-mensalista");
    btn.disabled = true;
    btn.textContent = "Enviando…";
    try {
      await api("/solicitacoes-mensalista", {
        method: "POST",
        body: JSON.stringify({
          nome,
          telefone,
          dia_semana: Number(selDia.value),
          hora_inicio: selHorario.value,
          duracao_min: Number(selDuracao.value),
          observacao: $("mensal-obs").value.trim(),
          aceite_privacidade: true,
        }),
      });
      formMensal.reset();
      atualizarHorariosMensal();
      mostrarMsg(msgMensal,
        "Pedido enviado! A Arena vai te chamar no WhatsApp para combinar. Nada fica reservado antes disso.", false);
    } catch (erro2) {
      mostrarMsg(msgMensal, erro2.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = "Enviar pedido";
    }
  });

  /* ---------------------------------------------------------------------
     Inicialização
  --------------------------------------------------------------------- */
  async function init() {
    try {
      INFO = await api("/info");
    } catch (e) {
      $("ano").textContent = new Date().getFullYear(); // só enfeite do rodapé
      mostrarMsg(msgAgenda, e.message, true);
      elHorarios.innerHTML = "";
      ["preco-normal-quando", "preco-nobre-quando"].forEach((id) => { $(id).textContent = "Preços indisponíveis agora."; });
      $("contato-funcionamento").innerHTML = "<li>Indisponível agora.</li>";
      mostrarMsg(msgMensal, e.message, true);
      return;
    }

    $("ano").textContent = INFO.hoje.slice(0, 4);
    renderizarPrecos();
    renderizarContato();
    prepararFormMensalista();

    estado.duracao = INFO.duracoes_permitidas[0];
    estado.inicio = INFO.hoje;
    iniciarRemarcar();
    renderizarDuracoes();
    carregarSemana();
  }

  init();
})();
