import { describe, expect, it, vi } from "vitest";
import { createHandler } from "../src/handler.js";
import { parseNote } from "../src/vault/frontmatter.js";
import type { InlineKeyboard } from "../src/telegram/client.js";
import { INVALID_OPTION, parseQuestion, questionText } from "../src/telegram/meta-question.js";
import type { TelegramMessage } from "../src/telegram/types.js";
import { fakeClock } from "../src/time/index.js";
import { InMemoryVaultStore } from "../src/vault/memory-store.js";
import { guardVaultStore } from "../src/vault/store.js";
import { makeRepos } from "./support/repos.js";

const SECRET = "s3cret";
const CHAT = 111;
const OTHER = 222; // também autorizado, para provar que chats não compartilham nada
const STRANGER = 333; // fora da allowlist
const BOT = 999;
const TASKS = "Hermes/tarefas";
const NOW = "2026-09-26T13:00:00Z"; // 10:00 em SP
const epoch = (iso: string) => Date.parse(iso) / 1000;

/** Mensagem do bot como o Telegram a guarda: id, texto atual e teclado atual. */
interface BotMessage extends TelegramMessage {
  keyboard?: InlineKeyboard;
}

function rig() {
  const clock = fakeClock(NOW);
  const mem = new InMemoryVaultStore();
  const repos = makeRepos(guardVaultStore(mem), clock);
  const bot: BotMessage[] = [];
  const toasts: { id: string; text?: string }[] = [];
  let nextId = 100;

  const find = (chat: number, id: number) => bot.find((m) => m.chat.id === chat && m.message_id === id);
  const handler = createHandler({
    config: { botToken: "tok", webhookSecret: SECRET, allowedChatIds: [CHAT, OTHER] },
    clock,
    ...repos,
    client: {
      async sendMessage(chat, text, keyboard) {
        bot.push({
          message_id: ++nextId,
          chat: { id: chat, type: "private" },
          from: { id: BOT, is_bot: true },
          date: Math.floor(clock.nowMs() / 1000),
          text,
          ...(keyboard && { keyboard }),
        });
      },
      async answerCallbackQuery(id, text) {
        toasts.push({ id, ...(text !== undefined && { text }) });
      },
      async editMessageText(chat, messageId, text) {
        const m = find(chat, messageId);
        if (m) {
          m.text = text;
          delete m.keyboard; // editar sem reply_markup remove os botões
        }
      },
    },
  });

  let updateId = 0;
  const post = async (update: object) =>
    (await handler({
      headers: { "x-telegram-bot-api-secret-token": SECRET },
      body: JSON.stringify({ update_id: ++updateId, ...update }),
    } as never)) as { statusCode: number };

  const snapshot = (m: BotMessage): TelegramMessage => {
    const { keyboard: _k, ...rest } = m;
    return rest;
  };

  return {
    clock,
    mem,
    repos,
    bot,
    toasts,
    last: () => bot[bot.length - 1]!,
    say: (text: string, opts: { chat?: number; replyTo?: BotMessage | TelegramMessage } = {}) => {
      const chat = opts.chat ?? CHAT;
      return post({
        message: {
          message_id: 5000 + updateId,
          chat: { id: chat, type: "private" },
          from: { id: chat, is_bot: false },
          date: Math.floor(clock.nowMs() / 1000),
          text,
          ...(opts.replyTo && { reply_to_message: "keyboard" in opts.replyTo ? snapshot(opts.replyTo as BotMessage) : opts.replyTo }),
        },
      });
    },
    /** Toca o botão `n` (1..) da mensagem, com o teclado que ela tinha. */
    press: (m: BotMessage, n: number, opts: { chat?: number; data?: string } = {}) =>
      post({
        callback_query: {
          id: `cb${updateId + 1}`,
          from: { id: opts.chat ?? CHAT },
          message: snapshot({ ...m, chat: { id: opts.chat ?? m.chat.id, type: "private" } }),
          data: opts.data ?? m.keyboard![n - 1]![0]!.data,
        },
      }),
    meta: (title: string, due?: string) =>
      repos.metas.create({ title, eventEpochSeconds: epoch("2026-09-20T15:00:00Z"), ...(due && { due: due as never }) }),
    note: async (id: string) => (await mem.read(`${TASKS}/${id}.md`))?.content ?? null,
    taskFiles: async () => mem.list(TASKS),
  };
}
type Rig = ReturnType<typeof rig>;

async function withMetas(r: Rig, ...titles: string[]) {
  for (const t of titles) await r.meta(t);
}

const CURRICULO = "2026-09-26-melhorar-curriculo";
const CHAT_ID_TASK = "2026-09-26-forjada";

describe("/tarefa sem metas ativas", () => {
  it("cria direto, sem perguntar (1)", async () => {
    const r = rig();
    await r.say("/tarefa melhorar currículo");
    expect(r.last().text).toBe(`Tarefa criada: melhorar currículo\nID: ${CURRICULO}`);
    expect(r.last().keyboard).toBeUndefined();
    expect(await r.note(CURRICULO)).not.toContain("meta:");
  });

  it("metas canceladas ou pausadas não contam como ativas", async () => {
    const r = rig();
    await withMetas(r, "Meta velha");
    await r.repos.metas.setStatus("meta-velha", "cancelada");
    await r.say("/tarefa melhorar currículo");
    expect(r.last().text).toContain("Tarefa criada");
    expect(r.last().keyboard).toBeUndefined();
  });
});

describe("a pergunta", () => {
  it("uma meta: mostra título da tarefa, a lista e os botões, e NÃO cria a tarefa (2)", async () => {
    const r = rig();
    await withMetas(r, "Conseguir um trabalho até o fim do ano");
    await r.say("/tarefa melhorar currículo");

    expect(r.last().text).toBe(
      [
        "Tarefa: melhorar currículo",
        `ID: ${CURRICULO}`,
        "",
        "Essa tarefa pertence a alguma meta?",
        "",
        "1. Conseguir um trabalho até o fim do ano",
        "   ID: conseguir-um-trabalho-ate-o-fim-do-ano",
        "",
        "2. Nenhuma meta específica",
        "",
        'Toque em um botão, ou responda a esta mensagem com o número (ou "nenhuma").',
      ].join("\n"),
    );
    expect(r.last().keyboard!.map((row) => row[0]!.text)).toEqual([
      "1. Conseguir um trabalho até o fim do ano",
      "2. Nenhuma meta específica",
    ]);
    expect(await r.taskFiles()).toEqual([]);
  });

  it("várias metas, só as ativas, com prazo da tarefa; callback_data pequeno e sem a meta nem o título (3)", async () => {
    const r = rig();
    await withMetas(r, "Conseguir um trabalho", "Evoluir como desenvolvedor", "Juntar R$100.000", "Meta pausada");
    const paused = (await r.mem.read("Hermes/metas/meta-pausada.md"))!;
    await r.mem.update("Hermes/metas/meta-pausada.md", paused.sha, paused.content.replace("status: ativa", "status: pausada"));

    await r.say("/tarefa melhorar currículo até 2026-10-02");
    const q = r.last();
    expect(q.text).toContain("Prazo: 2026-10-02");
    const buttons = q.keyboard!.flat();
    expect(buttons.map((b) => b.text)).toEqual([
      "1. Conseguir um trabalho",
      "2. Evoluir como desenvolvedor",
      "3. Juntar R$100.000",
      "4. Nenhuma meta específica",
    ]);
    expect(q.text).not.toContain("Meta pausada");
    for (const b of buttons) {
      expect(Buffer.byteLength(b.data)).toBeLessThanOrEqual(64);
      expect(b.data).toMatch(/^tm:[0-9a-f]{8}:\d$/);
    }
  });

  it("parseQuestion lê o que questionText escreve (com prazo e caracteres especiais)", async () => {
    const r = rig();
    const a = await r.meta("Juntar R$100.000 (2026)");
    const b = await r.meta("Evoluir: 100%");
    const task = { id: "2026-09-26-comprar-teclado-c", title: "comprar teclado C#", due: "2026-10-02" as never };
    const text = questionText(task, [a.meta, b.meta]);
    expect(parseQuestion(text)).toEqual({ task, options: ["juntar-r-100-000-2026", "evoluir-100", null] });
    // com aviso na frente
    expect(parseQuestion(`A meta X não está disponível.\n\n${text}`)?.task.id).toBe(task.id);
  });

  it("parseQuestion recusa texto adulterado", async () => {
    const r = rig();
    const a = await r.meta("Meta A");
    const ok = questionText({ id: "2026-09-26-teste", title: "teste" }, [a.meta]);
    expect(parseQuestion(ok)).not.toBeNull();
    expect(parseQuestion(ok.replace("ID: 2026-09-26-teste", "ID: 2026-09-26-outra"))).toBeNull(); // ID != título
    expect(parseQuestion(ok.replace("1. Meta A", "3. Meta A"))).toBeNull(); // numeração
    expect(parseQuestion(ok.replace("   ID: meta-a", "   ID: ../../x"))).toBeNull(); // ID de meta inválido
    expect(parseQuestion(ok.replace("Essa tarefa pertence a alguma meta?", "Outra coisa"))).toBeNull();
    expect(parseQuestion(ok.replace("2. Nenhuma meta específica", "2. Outra"))).toBeNull(); // sem a opção "nenhuma"
    expect(parseQuestion("qualquer texto")).toBeNull();
  });
});

describe("resposta por botão", () => {
  it("escolher a meta cria a tarefa vinculada, com o ID da meta (4, 12, 14)", async () => {
    const r = rig();
    await withMetas(r, "Conseguir um trabalho até o fim do ano", "Evoluir como desenvolvedor");
    await r.say("/tarefa melhorar currículo");
    const q = r.last();

    expect((await r.press(q, 1)).statusCode).toBe(200);

    const result = `Tarefa criada: melhorar currículo\nID: ${CURRICULO}\nMeta: Conseguir um trabalho até o fim do ano`;
    expect(q.text).toBe(result); // a pergunta virou o resultado, sem botões
    expect(q.keyboard).toBeUndefined();
    expect(r.toasts.at(-1)?.text).toBe("Tarefa criada: melhorar currículo");

    const note = (await r.note(CURRICULO))!;
    expect(note).toContain("meta: conseguir-um-trabalho-ate-o-fim-do-ano\n"); // o ID, não o "1" nem o título
    expect(parseNote(note, "x").data.meta).toBe("conseguir-um-trabalho-ate-o-fim-do-ano");
    expect(note).toContain("# melhorar currículo\n\nMeta: [[conseguir-um-trabalho-ate-o-fim-do-ano]]\n");
  });

  it("'Nenhuma meta específica' cria sem o campo meta (5, 13)", async () => {
    const r = rig();
    await withMetas(r, "Meta A", "Meta B");
    await r.say("/tarefa melhorar currículo");
    const q = r.last();
    await r.press(q, 3);

    expect(q.text).toBe(`Tarefa criada: melhorar currículo\nID: ${CURRICULO}\nSem meta específica.`);
    const note = (await r.note(CURRICULO))!;
    expect(note).not.toMatch(/^meta:/m);
    expect(note).not.toContain("null");
    expect(note).not.toContain("[[");
  });

  it("o prazo da pergunta vai para a tarefa", async () => {
    const r = rig();
    await withMetas(r, "Meta A");
    await r.say("/tarefa melhorar currículo até 2026-10-02");
    await r.press(r.last(), 1);
    expect(await r.note(CURRICULO)).toContain("due: 2026-10-02");
  });

  it("o mesmo toque reenviado pelo Telegram não duplica a tarefa nem faz commit extra (23)", async () => {
    const r = rig();
    await withMetas(r, "Meta A");
    await r.say("/tarefa melhorar currículo");
    const q = r.last();
    const data = q.keyboard![0]![0]!.data;
    const snapshotBefore = { ...q };

    await r.press(q, 1);
    const commits = r.mem.commits.length;
    // reentrega do MESMO update: o Telegram manda a mensagem como estava (com a pergunta)
    expect((await r.press(snapshotBefore, 1, { data })).statusCode).toBe(200);

    expect(r.mem.commits.length).toBe(commits);
    expect(await r.taskFiles()).toHaveLength(1);
    expect(r.toasts.at(-1)?.text).toBe("Tarefa já existe: melhorar currículo");
  });

  it("/tarefa reenviada depois de criada responde 'já existe', sem perguntar de novo (23)", async () => {
    const r = rig();
    await withMetas(r, "Meta A");
    await r.say("/tarefa melhorar currículo");
    await r.press(r.last(), 1);
    const commits = r.mem.commits.length;
    const before = r.bot.length;

    await r.say("/tarefa melhorar currículo");
    expect(r.bot.length).toBe(before + 1);
    expect(r.last().text).toBe(`Tarefa já existe: melhorar currículo\nID: ${CURRICULO}\nMeta: meta-a`);
    expect(r.last().keyboard).toBeUndefined();
    expect(r.mem.commits.length).toBe(commits);
  });

  it("o ID mantém a data do /tarefa original, mesmo respondendo depois da meia-noite (23)", async () => {
    const r = rig();
    await withMetas(r, "Meta A");
    r.clock.set("2026-09-27T02:50:00Z"); // 26/09 23:50 em SP
    await r.say("/tarefa melhorar currículo");
    const q = r.last();
    r.clock.set("2026-09-27T03:20:00Z"); // 27/09 00:20 em SP
    await r.press(q, 1);
    expect(await r.note(CURRICULO)).not.toBeNull(); // 2026-09-26-..., não 2026-09-27-...
    expect(await r.taskFiles()).toEqual([`${TASKS}/${CURRICULO}.md`]);
  });
});

describe("resposta por texto (reply à pergunta)", () => {
  it("número, 'não' e 'nenhuma' (4, 5, 6, 7)", async () => {
    const r = rig();
    await withMetas(r, "Meta A", "Meta B");

    await r.say("/tarefa primeira");
    await r.say("2", { replyTo: r.last() });
    expect(r.last().text).toBe("Tarefa criada: primeira\nID: 2026-09-26-primeira\nMeta: Meta B");
    expect(await r.note("2026-09-26-primeira")).toContain("meta: meta-b\n");

    for (const [title, answer] of [["segunda", "3"], ["terceira", "não"], ["quarta", "Nenhuma"], ["quinta", "nao"]] as const) {
      await r.say(`/tarefa ${title}`);
      await r.say(answer, { replyTo: r.last() });
      expect(r.last().text).toBe(`Tarefa criada: ${title}\nID: 2026-09-26-${title}\nSem meta específica.`);
      expect(await r.note(`2026-09-26-${title}`)).not.toMatch(/^meta:/m);
    }
  });

  it("depois de responder, a pergunta é reescrita e perde os botões", async () => {
    const r = rig();
    await withMetas(r, "Meta A");
    await r.say("/tarefa melhorar currículo");
    const q = r.last();
    await r.say("1", { replyTo: q });
    expect(q.text).toBe("Tarefa: melhorar currículo\nPergunta respondida.");
    expect(q.keyboard).toBeUndefined();
  });

  it("número fora da lista e texto qualquer: recusa e não cria (8, 9)", async () => {
    const r = rig();
    await withMetas(r, "Meta A", "Meta B", "Meta C");
    await r.say("/tarefa melhorar currículo");
    const q = r.last();

    for (const bad of ["5", "0", "banana", "1a", "-1"]) {
      await r.say(bad, { replyTo: q });
      expect(r.last().text).toBe(INVALID_OPTION);
    }
    expect(await r.taskFiles()).toEqual([]);
    expect(q.keyboard).toBeDefined(); // a pergunta continua valendo

    await r.say("1", { replyTo: q });
    expect(await r.taskFiles()).toHaveLength(1);
  });

  it("botão com número fora da lista (data adulterada com tag correta) é recusado", async () => {
    const r = rig();
    await withMetas(r, "Meta A");
    await r.say("/tarefa melhorar currículo");
    const q = r.last();
    const tag = /^tm:([0-9a-f]{8}):/.exec(q.keyboard![0]![0]!.data)![1];
    await r.press(q, 1, { data: `tm:${tag}:9` });
    expect(r.toasts.at(-1)?.text).toBe(INVALID_OPTION);
    expect(await r.taskFiles()).toEqual([]);
  });

  it("mensagem solta '1' (sem reply) é tratada como mensagem normal", async () => {
    const r = rig();
    await withMetas(r, "Meta A");
    await r.say("/tarefa melhorar currículo");
    await r.say("1");
    expect(r.last().text).toContain("Envie um comando");
    expect(await r.taskFiles()).toEqual([]);
  });

  it("reply a uma mensagem que não é pergunta do Hermes: mensagem normal", async () => {
    const r = rig();
    await r.say("/ping");
    await r.say("1", { replyTo: r.last() });
    expect(r.last().text).toContain("Envie um comando");
  });

  it("uma mensagem do USUÁRIO que imita a pergunta não vale (só mensagens do bot)", async () => {
    const r = rig();
    await withMetas(r, "Meta A");
    const fake = { message_id: 1, chat: { id: CHAT, type: "private" }, from: { id: CHAT, is_bot: false }, date: epoch(NOW), text: questionText({ id: CHAT_ID_TASK, title: "forjada" }, [(await r.repos.metas.find("meta-a"))!]) };
    await r.say("1", { replyTo: fake });
    expect(r.last().text).toContain("Envie um comando");
    expect(await r.taskFiles()).toEqual([]);
  });

  it("um comando dado como reply continua sendo comando", async () => {
    const r = rig();
    await withMetas(r, "Meta A");
    await r.say("/tarefa melhorar currículo");
    await r.say("/ping", { replyTo: r.last() });
    expect(r.last().text).toMatch(/^pong /);
  });
});
describe("meta que mudou entre a pergunta e a resposta", () => {
  it("meta apagada do Vault: não cria referência quebrada, avisa e mostra a lista atualizada (10)", async () => {
    const r = rig();
    await withMetas(r, "Meta A", "Meta B");
    await r.say("/tarefa melhorar currículo");
    const q = r.last();
    r.mem.externalDelete("Hermes/metas/meta-a.md");

    await r.press(q, 1);
    expect(await r.taskFiles()).toEqual([]);
    expect(r.toasts.at(-1)?.text).toBe("A meta selecionada não está mais disponível. Escolha outra meta.");
    expect(q.keyboard).toBeUndefined(); // a pergunta velha foi substituída
    const fresh = r.last();
    expect(fresh.text).toContain("A meta selecionada não está mais disponível. Escolha outra meta.");
    expect(fresh.text).toContain("1. Meta B");
    expect(fresh.text).not.toContain("Meta A");
    expect(fresh.keyboard!.flat().map((b) => b.text)).toEqual(["1. Meta B", "2. Nenhuma meta específica"]);

    // a nova pergunta funciona (e o botão 1 agora é a Meta B)
    await r.press(fresh, 1);
    expect(await r.note(CURRICULO)).toContain("meta: meta-b\n");
  });

  it("meta cancelada ou concluída: idem, também por texto (11)", async () => {
    const r = rig();
    await withMetas(r, "Meta A", "Meta B");
    await r.say("/tarefa melhorar currículo");
    const q = r.last();
    await r.repos.metas.setStatus("meta-a", "cancelada");

    await r.say("1", { replyTo: q });
    expect(await r.taskFiles()).toEqual([]);
    expect(r.last().text).toContain("A meta selecionada não está mais disponível. Escolha outra meta.");
    expect(r.last().text).not.toContain("1. Meta A");

    await r.repos.metas.setStatus("meta-b", "concluida");
    await r.say("1", { replyTo: r.last() });
    expect(await r.taskFiles()).toEqual([]);
    expect(r.last().text).toContain("1. Nenhuma meta específica"); // sobrou só "nenhuma"
    await r.say("1", { replyTo: r.last() });
    expect(await r.note(CURRICULO)).not.toMatch(/^meta:/m);
  });

  it("'nenhuma' continua funcionando mesmo depois de todas as metas sumirem", async () => {
    const r = rig();
    await withMetas(r, "Meta A");
    await r.say("/tarefa melhorar currículo");
    const q = r.last();
    await r.repos.metas.setStatus("meta-a", "cancelada");
    await r.say("nenhuma", { replyTo: q });
    expect(r.last().text).toContain("Sem meta específica.");
  });
});

describe("atalho #meta", () => {
  it("cria direto, sem perguntar (mesmas validações)", async () => {
    const r = rig();
    await withMetas(r, "Evoluir como desenvolvedor", "Outra");
    await r.say("/tarefa estudar system design #evoluir-como-desenvolvedor");
    expect(r.last().text).toBe(
      "Tarefa criada: estudar system design\nID: 2026-09-26-estudar-system-design\nMeta: Evoluir como desenvolvedor",
    );
    expect(r.last().keyboard).toBeUndefined();
    expect(await r.note("2026-09-26-estudar-system-design")).toContain("meta: evoluir-como-desenvolvedor\n");
  });

  it("meta inexistente ou inativa: recusa e não cria", async () => {
    const r = rig();
    await withMetas(r, "Meta A");
    await r.say("/tarefa x #nao-existe");
    expect(r.last().text).toBe("Meta não encontrada: nao-existe. Veja os IDs em /metas.");

    await r.repos.metas.setStatus("meta-a", "cancelada");
    await r.say("/tarefa x #meta-a");
    expect(r.last().text).toBe('A meta "Meta A" não está ativa (cancelada).');
    expect(await r.taskFiles()).toEqual([]);
  });
});

describe("várias perguntas, chats e segurança", () => {
  it("segunda /tarefa com uma pergunta pendente: nada se perde nem se sobrescreve (21)", async () => {
    const r = rig();
    await withMetas(r, "Meta A");
    await r.say("/tarefa estudar system design");
    const first = r.last();
    await r.say("/tarefa estudar AWS");
    const second = r.last();
    expect(second).not.toBe(first);
    expect(second.text).toContain("Tarefa: estudar AWS");
    expect(first.keyboard).toBeDefined(); // a primeira continua respondível
    expect(await r.taskFiles()).toEqual([]);

    await r.press(second, 2);
    await r.say("1", { replyTo: first });
    expect(await r.note("2026-09-26-estudar-aws")).not.toMatch(/^meta:/m);
    expect(await r.note("2026-09-26-estudar-system-design")).toContain("meta: meta-a\n");
  });

  it("dois chats não compartilham nada (19, 20)", async () => {
    const r = rig();
    await withMetas(r, "Meta A");
    await r.say("/tarefa do chat um", { chat: CHAT });
    const q = r.last();
    expect(q.chat.id).toBe(CHAT);

    // o outro chat manda "1" solto: não tem contexto
    await r.say("1", { chat: OTHER });
    expect(r.last().chat.id).toBe(OTHER);
    expect(r.last().text).toContain("Envie um comando");
    expect(await r.taskFiles()).toEqual([]);

    // a pergunta é respondida no chat dela
    await r.say("1", { chat: CHAT, replyTo: q });
    expect(await r.taskFiles()).toHaveLength(1);
  });

  it("chat fora da allowlist: botão e texto são ignorados em silêncio (19)", async () => {
    const r = rig();
    await withMetas(r, "Meta A");
    await r.say("/tarefa melhorar currículo");
    const q = r.last();
    const sent = r.bot.length;

    expect((await r.press(q, 1, { chat: STRANGER })).statusCode).toBe(200);
    expect((await r.say("1", { chat: STRANGER, replyTo: { ...q, chat: { id: STRANGER, type: "private" } } })).statusCode).toBe(200);

    expect(await r.taskFiles()).toEqual([]);
    expect(r.bot.length).toBe(sent);
    expect(r.toasts).toEqual([]);
    expect(q.keyboard).toBeDefined();
  });

  it("botão adulterado: tag de outra tarefa, formato errado, mensagem sem texto", async () => {
    const r = rig();
    await withMetas(r, "Meta A");
    await r.say("/tarefa melhorar currículo");
    const q = r.last();

    await r.press(q, 1, { data: "tm:00000000:1" });
    expect(r.toasts.at(-1)?.text).toBe("Botão inválido.");
    await r.press(q, 1, { data: "outra:coisa" });
    expect(r.toasts.at(-1)?.text).toBe("Botão inválido.");

    // botão de uma pergunta colado noutra mensagem do bot (ex.: check-in): não vale
    await r.say("/ping");
    await r.press({ ...r.last(), keyboard: q.keyboard }, 1);
    expect(r.toasts.at(-1)?.text).toBe("Botão inválido.");
    expect(await r.taskFiles()).toEqual([]);
  });

  it("pergunta expirada (24 h): não cria, avisa e limpa a pergunta (22)", async () => {
    const r = rig();
    await withMetas(r, "Meta A");
    await r.say("/tarefa melhorar currículo");
    const q = r.last();
    const q2 = (await r.say("/tarefa outra"), r.last());

    r.clock.advanceMs(24 * 3600 * 1000 + 5000);
    await r.press(q, 1);
    expect(r.toasts.at(-1)?.text).toBe("Essa pergunta expirou. Envie /tarefa de novo.");
    expect(q.text).toBe("Tarefa: melhorar currículo\nPergunta expirada.");
    expect(q.keyboard).toBeUndefined();

    await r.say("1", { replyTo: q2 });
    expect(r.last().text).toBe("Essa pergunta expirou. Envie /tarefa de novo.");
    expect(await r.taskFiles()).toEqual([]);
  });

  it("pouco antes de 24 h ainda vale", async () => {
    const r = rig();
    await withMetas(r, "Meta A");
    await r.say("/tarefa melhorar currículo");
    r.clock.advanceMs(23 * 3600 * 1000);
    await r.press(r.last(), 1);
    expect(await r.taskFiles()).toHaveLength(1);
  });
});

describe("depois de criada com meta", () => {
  async function created() {
    const r = rig();
    await withMetas(r, "Conseguir um trabalho", "Evoluir como desenvolvedor");
    await r.say("/tarefa melhorar currículo até 2026-09-26");
    await r.press(r.last(), 1);
    await r.say("/tarefa estudar system design até 2026-09-28");
    await r.press(r.last(), 2);
    await r.say("/tarefa comprar teclado");
    await r.say("2", { replyTo: r.last() });
    return r;
  }

  it("/feita preserva meta, corpo e demais campos (15, 24, 25)", async () => {
    const r = await created();
    // o usuário escreve no corpo e no frontmatter (chave desconhecida) pelo Obsidian
    const file = (await r.mem.read(`${TASKS}/${CURRICULO}.md`))!;
    await r.mem.update(`${TASKS}/${CURRICULO}.md`, file.sha, file.content.replace("---\n\n#", "prioridade: alta # meu\n---\n\n#") + "\nMinhas notas.\n");
    const before = (await r.note(CURRICULO))!;

    r.clock.advanceMs(3600_000);
    await r.say("/feita melhorar currículo");
    expect(r.last().text).toBe("Feita: melhorar currículo");

    const after = (await r.note(CURRICULO))!;
    const b = parseNote(before, "x");
    const a = parseNote(after, "x");
    expect(a.data.meta).toBe("conseguir-um-trabalho");
    expect(a.data.status).toBe("feita");
    expect(a.data.done_at).toBeDefined();
    expect({ ...a.data, status: 0, done_at: 0, updated: 0 }).toEqual({ ...b.data, status: 0, done_at: 0, updated: 0 });
    expect(after).toContain("prioridade: alta # meu");
    expect(after.endsWith("# melhorar currículo\n\nMeta: [[conseguir-um-trabalho]]\n\nMinhas notas.\n")).toBe(true);
  });

  it("/cancelar preserva meta (16)", async () => {
    const r = await created();
    await r.say("/cancelar estudar system");
    expect(r.last().text).toBe("Cancelada: estudar system design");
    const data = parseNote((await r.note("2026-09-26-estudar-system-design"))!, "x").data;
    expect(data.meta).toBe("evoluir-como-desenvolvedor");
    expect(data.status).toBe("cancelada");
  });

  it("/feita com edição concorrente (conflito de sha): relê, reaplica e mantém a meta (26)", async () => {
    const r = await created();
    let once = true;
    // simula o Obsidian editando entre a leitura e a escrita
    const path = `${TASKS}/${CURRICULO}.md`;
    r.mem.beforeWrite = (op, p) => {
      if (op === "update" && p === path && once) {
        once = false;
        const raw = (r.mem as unknown as { files: Map<string, string> }).files.get(p)!;
        r.mem.externalWrite(p, raw + "\nEditado no Obsidian.\n");
      }
    };
    await r.say("/feita melhorar currículo");
    expect(r.last().text).toBe("Feita: melhorar currículo");
    const note = (await r.note(CURRICULO))!;
    expect(note).toContain("Editado no Obsidian.");
    expect(note).toContain("meta: conseguir-um-trabalho\n");
    expect(note).toContain("status: feita");
  });

  it("/hoje mostra a meta de cada tarefa (17)", async () => {
    const r = await created();
    await r.say("/hoje");
    expect(r.last().text).toBe(
      [
        "Hoje, sábado 26/09",
        "",
        "Para hoje (1):",
        "- melhorar currículo",
        "  Meta: Conseguir um trabalho",
        "",
        "Sem prazo (1):",
        "- comprar teclado",
        "  Meta: Evoluir como desenvolvedor",
        "",
        "1 tarefa com prazo futuro. Veja em /semana.",
      ].join("\n"),
    );
  });

  it("/semana mostra a meta, e tarefa sem meta fica sem a linha (18)", async () => {
    const r = await created();
    await r.say("/tarefa sem meta nenhuma");
    await r.say("nenhuma", { replyTo: r.last() });
    await r.say("/semana");
    expect(r.last().text).toBe(
      [
        "Semana 21/09 a 27/09",
        "",
        "sábado 26/09 (hoje):",
        "- melhorar currículo",
        "  Meta: Conseguir um trabalho",
        "",
        "Sem prazo (2):",
        "- comprar teclado",
        "  Meta: Evoluir como desenvolvedor",
        "- sem meta nenhuma",
        "",
        "1 tarefa depois desta semana.",
      ].join("\n"),
    );
  });

  it("meta concluída ou cancelada NÃO mexe nas tarefas, e a listagem ainda mostra o título dela", async () => {
    const r = await created();
    await r.repos.metas.setStatus("conseguir-um-trabalho", "concluida");
    await r.repos.metas.setStatus("evoluir-como-desenvolvedor", "cancelada");

    const data = parseNote((await r.note(CURRICULO))!, "x").data;
    expect(data.status).toBe("pendente");
    expect(data.meta).toBe("conseguir-um-trabalho");

    await r.say("/hoje");
    expect(r.last().text).toContain("- melhorar currículo\n  Meta: Conseguir um trabalho");
  });

  it("meta apagada do Vault: /hoje mostra o ID, sem falhar", async () => {
    const r = await created();
    r.mem.externalDelete("Hermes/metas/conseguir-um-trabalho.md");
    await r.say("/hoje");
    expect(r.last().text).toContain("- melhorar currículo\n  Meta: conseguir-um-trabalho");
  });
});

describe("erros de infraestrutura", () => {
  it("Vault fora do ar ao confirmar: 500 (o Telegram reenvia) e nada foi criado", async () => {
    const r = rig();
    await withMetas(r, "Meta A");
    await r.say("/tarefa melhorar currículo");
    const q = r.last();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { VaultUnavailable } = await import("../src/vault/errors.js");
    r.mem.beforeWrite = () => {
      throw new VaultUnavailable("fora do ar");
    };
    expect((await r.press(q, 1)).statusCode).toBe(500);
    expect(await r.taskFiles()).toEqual([]);

    r.mem.beforeWrite = undefined;
    expect((await r.press(q, 1)).statusCode).toBe(200); // o reenvio cria
    expect(await r.taskFiles()).toHaveLength(1);
  });
});
