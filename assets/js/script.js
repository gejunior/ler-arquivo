/**
 * script.js - transforma o texto de um PDF de PPC no bloco "raw" do fluxograma.
 *
 * Cada disciplina vira:
 *   ["CODIGO", "Nome", semestre, aulas_semanais, extensao(0/1), ["PRE1", "PRE2"]]
 *
 * Fluxo:
 *   extractLines(pdfjsLib, buffer)  -> linhas com células (usa as posições x/y do texto)
 *   linhasParaDisciplinas(linhas)   -> lista de disciplinas
 *   buildRaw(discs, opcoes)         -> { raw, avisos }
 *   formatRaw(raw)                  -> texto '"raw": [ ... ]'
 */

const CODE_RE = /^[A-Z][A-Z0-9]{2,4}$/;
const CODE_IN_TEXT = /(?<![A-Za-zÀ-ÿ0-9])[A-Z][A-Z0-9]{2,4}(?![A-Za-zÀ-ÿ0-9])/g;
const NOT_CODES = new Set([
  "CH", "TOTAL", "AULA", "AULAS", "NAO", "NÃO", "SIM", "PRE", "PRÉ", "EAD",
  "IFSP", "PPC", "MEC", "LDB", "CNE", "CNPJ", "ENADE", "NDE", "CPA", "PDF", "CPU", "NOME"
]);
const SEM_RE = /(\d{1,2})\s*[ºo°ª]?\s*(?:semestre|per[ií]odo|m[óo]dulo)/gi;
const SEM_RE2 = /(?:semestre|per[ií]odo|m[óo]dulo)\s*(\d{1,2})\b/gi;
const OPT_RE = /optativ/gi;

const limpa = s => (s || "").replace(/\s+/g, " ").trim();
const semAcento = s => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const ehCodigo = t => CODE_RE.test(t) && !NOT_CODES.has(t);

// ---------- 1. PDF -> linhas com células ----------

/** Junta itens de texto da mesma altura em linhas e separa em células pelos espaços grandes. */
export function itemsToLines(items) {
  const its = items
    .filter(i => i.str && i.str.trim() !== "")
    .map(i => ({ str: i.str, x: i.x, y: i.y, w: i.w || 0, h: i.h || 10 }));
  its.sort((a, b) => b.y - a.y || a.x - b.x);

  const grupos = [];
  for (const it of its) {
    const g = grupos[grupos.length - 1];
    if (g && Math.abs(g.y - it.y) <= Math.max(2, it.h * 0.4)) g.items.push(it);
    else grupos.push({ y: it.y, items: [it] });
  }
  return grupos.map(g => ({ y: g.y, cells: paraCelulas(g.items) }));
}

function paraCelulas(items) {
  items.sort((a, b) => a.x - b.x);
  const cells = [];
  let cur = null;
  for (const it of items) {
    if (cur) {
      const gap = it.x - (cur.x + cur.w);
      if (gap <= Math.max(5, it.h * 0.6)) {
        cur.text += (gap > 0.3 && !cur.text.endsWith(" ") && !it.str.startsWith(" ") ? " " : "") + it.str;
        cur.w = it.x + it.w - cur.x;
        continue;
      }
    }
    cur = { x: it.x, w: it.w, text: it.str };
    cells.push(cur);
  }
  cells.forEach(c => { c.text = limpa(c.text); });
  return cells;
}

/** Lê o PDF com o pdf.js e devolve as linhas de todas as páginas. */
export async function extractLines(pdfjsLib, arrayBuffer) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const linhas = [];
  let totalItens = 0;
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items = content.items.map(i => ({
      str: i.str,
      x: i.transform[4],
      y: i.transform[5],
      w: i.width,
      h: i.height || Math.abs(i.transform[3])
    }));
    totalItens += items.filter(i => i.str.trim()).length;
    itemsToLines(items).forEach(l => linhas.push({ ...l, page: p }));
  }
  if (!totalItens) {
    throw new Error("O PDF não tem texto selecionável (provavelmente é um documento escaneado).");
  }
  return linhas;
}

// ---------- 2. linhas -> disciplinas ----------

function acharSemestre(texto) {
  let achado = null;
  for (const m of texto.matchAll(SEM_RE)) achado = { pos: m.index, tipo: "sem", n: +m[1] };
  for (const m of texto.matchAll(SEM_RE2)) if (!achado || m.index > achado.pos) achado = { pos: m.index, tipo: "sem", n: +m[1] };
  for (const m of texto.matchAll(OPT_RE)) if (!achado || m.index > achado.pos) achado = { pos: m.index, tipo: "opt", n: null };
  return achado ? { tipo: achado.tipo, n: achado.n } : null;
}

const centro = c => c.x + (c.w || 0) / 2;

/** Cabeçalho de tabela: guarda as colunas (posição + texto) para classificar as células das linhas seguintes. */
function detectarCabecalho(cells) {
  const t = cells.map(c => semAcento(c.text));
  const temCodigo = t.some(x => /^(codigo|sigla|cod\.?)$/.test(x) || x.startsWith("codigo"));
  const temReq = t.some(x => x.includes("requisito"));
  if (cells.length >= 3 && (temCodigo || temReq)) {
    return cells.map(c => ({ cx: centro(c), text: semAcento(c.text) }));
  }
  return null;
}

function chavesDoCabecalho(cab) {
  const keys = cab.map(() => null);
  cab.forEach((c, i) => { if (/requisito|^pre/.test(c.text)) keys[i] = "pre"; });
  let ia = cab.findIndex(c => c.text.includes("aula") && (c.text.includes("seman") || c.text.includes("/sem")));
  if (ia < 0) ia = cab.findIndex(c => c.text.includes("aula"));
  if (ia >= 0 && keys[ia] === null) keys[ia] = "aulas";
  return keys;
}

function colunaMaisProxima(cab, cx) {
  let best = 0, dist = Infinity;
  cab.forEach((c, i) => {
    const d = Math.abs(c.cx - cx);
    if (d < dist) { dist = d; best = i; }
  });
  return best;
}

export function linhasParaDisciplinas(linhas) {
  const discs = [];
  let sem = null, cab = null, keys = null, last = null, prevY = null, prevPage = null;

  for (const ln of linhas) {
    const cells = ln.cells;
    if (!cells.length) continue;
    const texts = cells.map(c => c.text);
    const junto = texts.join(" ");
    const ic = texts.slice(0, 2).findIndex(ehCodigo);
    const gapY = prevPage === ln.page && prevY !== null ? prevY - ln.y : Infinity;
    prevY = ln.y; prevPage = ln.page;

    if (ic < 0) {
      const h = detectarCabecalho(cells);
      if (h) { cab = h; keys = chavesDoCabecalho(cab); last = null; continue; }

      // segunda linha do cabeçalho (ex.: "Aulas" / "semanais")
      if (cab && !last && gapY <= 16 && cells.length <= cab.length) {
        cells.forEach(c => { cab[colunaMaisProxima(cab, centro(c))].text += " " + semAcento(c.text); });
        keys = chavesDoCabecalho(cab);
        continue;
      }

      // título de semestre / optativas
      if (junto.length < 70) {
        const s = acharSemestre(junto);
        if (s) { sem = s; last = null; continue; }
      }

      // continuação de célula com quebra de linha (nome ou pré-requisito muito longo)
      if (last && gapY <= 16 && !/^(p[áa]gina|total)\b/i.test(junto) && !/^\d+$/.test(junto)) {
        for (const c of cells) {
          if (Math.abs(c.x - last.nomeX) <= 15) last.nome = limpa(last.nome + " " + c.text);
          else if (cab && keys && keys[colunaMaisProxima(cab, centro(c))] === "pre") {
            last.preTxt = limpa(last.preTxt + " " + c.text);
          }
        }
      } else {
        last = null;
      }
      continue;
    }

    // linha de disciplina
    const nomeIdx = texts.findIndex((t, i) => i > ic && t && !/^\d+$/.test(t));
    if (nomeIdx < 0) continue;
    const resto = cells.slice(nomeIdx + 1);
    let preTxt = "", aulas = null;

    if (cab && keys && keys.some(Boolean)) {
      for (const c of resto) {
        const key = keys[colunaMaisProxima(cab, centro(c))];
        if (key === "pre") preTxt += " " + c.text;
        else if (key === "aulas" && aulas === null) {
          const m = c.text.match(/\d+/);
          if (m) aulas = +m[0];
        }
      }
    } else {
      for (const c of resto) {
        if (/^\d+$/.test(c.text)) { if (aulas === null && +c.text >= 1 && +c.text <= 10) aulas = +c.text; }
        else preTxt += " " + c.text;
      }
    }

    last = {
      codigo: texts[ic],
      nome: texts[nomeIdx],
      nomeX: cells[nomeIdx].x,
      aulas,
      preTxt: limpa(preTxt),
      sem,
      pagina: ln.page
    };
    discs.push(last);
  }
  return discs;
}

// ---------- 3. disciplinas -> raw ----------

export function buildRaw(discs, { extCodes = ["EXT", "PRI"], semOptativa = 10, manterOrdem = false } = {}) {
  const avisos = [];
  const vistos = new Set();
  const unicos = [];
  for (const d of discs) {
    if (vistos.has(d.codigo)) { avisos.push(`Código repetido ignorado: ${d.codigo} (pág. ${d.pagina})`); continue; }
    vistos.add(d.codigo);
    unicos.push(d);
  }
  const codigos = new Set(unicos.map(d => d.codigo));
  const porNome = unicos.map(d => [semAcento(d.nome), d.codigo]);
  const SEM_PRE = new Set(["", "-", "—", "–", "nao ha", "nenhum", "nao possui"]);

  const raw = unicos.map(d => {
    const achados = d.preTxt.match(CODE_IN_TEXT) || [];
    let pres = achados.filter(c => codigos.has(c) && c !== d.codigo);
    achados.filter(c => !codigos.has(c) && !NOT_CODES.has(c))
      .forEach(c => avisos.push(`Pré-requisito "${c}" de ${d.codigo} não existe na lista de disciplinas`));

    if (!achados.length && !SEM_PRE.has(semAcento(d.preTxt))) {
      const txt = semAcento(d.preTxt);
      const pedacos = txt.split(/[;,/]| e /).map(p => p.trim()).filter(p => p.length >= 6);
      for (const [nm, cod] of porNome) {
        if (cod === d.codigo) continue;
        if (txt.includes(nm) || pedacos.some(p => nm.startsWith(p))) pres.push(cod);
      }
    }
    pres = [...new Set(pres)];
    if (!pres.length && !achados.length && !SEM_PRE.has(semAcento(d.preTxt))) {
      avisos.push(`Pré-requisito "${d.preTxt}" de ${d.codigo} não foi reconhecido (confira manualmente)`);
    }

    let nome = d.nome, semestre = 0;
    if (d.sem && d.sem.tipo === "opt") {
      semestre = semOptativa;
      if (!semAcento(nome).includes("optativ")) nome += " (optativa)";
    } else if (d.sem) {
      semestre = d.sem.n;
    } else {
      avisos.push(`Semestre não identificado para ${d.codigo} (ficou 0)`);
    }
    if (d.aulas === null) avisos.push(`Aulas não identificadas para ${d.codigo} (ficou 0)`);

    const ext = extCodes.some(p => d.codigo === p || d.codigo.startsWith(p)) ||
      semAcento(nome).includes("extens") ? 1 : 0;
    return [d.codigo, nome, semestre, d.aulas ?? 0, ext, pres];
  });

  if (!manterOrdem) {
    raw.sort((a, b) => a[2] - b[2] || a[1].localeCompare(b[1], "pt-BR", { sensitivity: "base" }));
  }
  return { raw, avisos };
}

export function formatRaw(raw) {
  return '"raw": [\n  ' + raw.map(r => JSON.stringify(r)).join(",\n  ") + "\n]";
}