#!/usr/bin/env python3
"""
ppc_para_raw.py - lê o PDF do PPC de um curso e gera o bloco "raw" do fluxograma.

Cada linha gerada tem o formato:
    ["CODIGO", "Nome da disciplina", semestre, aulas_semanais, extensao(0/1), ["PRE1", "PRE2"]]

Uso:
    pip install pdfplumber
    python ppc_para_raw.py ppc.pdf                      # imprime no terminal
    python ppc_para_raw.py ppc.pdf -o raw.json          # salva em arquivo
    python ppc_para_raw.py ppc.pdf --debug              # mostra o que foi lido (use se algo vier errado)
    python ppc_para_raw.py ppc.pdf --ext-codes EXT,PRI,CSOC

Como funciona:
  1. Procura as tabelas do PDF. Antes de cada tabela, procura um título do tipo
     "1º Semestre", "2º Período", "Optativas" para saber a qual semestre ela pertence.
  2. Em cada linha, o primeiro valor com cara de código (3 a 5 letras/números maiúsculos,
     ex.: ALP1, CID, TCC2) é o código; o texto ao lado é o nome.
  3. As colunas "Pré-requisito" e "Aulas" são achadas pelo cabeçalho da tabela.
     Se não houver cabeçalho reconhecível, usa o primeiro número pequeno como aulas
     e os códigos que aparecem depois do nome como pré-requisitos.
  4. Se o pré-requisito vier escrito por extenso (nome em vez de código), converte pelo nome.
"""
import argparse
import json
import re
import sys
import unicodedata

try:
    import pdfplumber
except ImportError:
    sys.exit("Falta instalar a biblioteca:  pip install pdfplumber")

CODE_RE = re.compile(r"^[A-Z][A-Z0-9]{2,4}$")
CODE_IN_TEXT = re.compile(r"\b[A-Z][A-Z0-9]{2,4}\b")
SEM_RE = re.compile(r"(\d{1,2})\s*[ºo°ª]?\s*(?:semestre|per[ií]odo|m[óo]dulo)", re.I)
SEM_RE2 = re.compile(r"(?:semestre|per[ií]odo|m[óo]dulo)\s*(\d{1,2})\b", re.I)
OPT_RE = re.compile(r"optativ", re.I)
# palavras em maiúsculas que aparecem em tabelas e NÃO são códigos de disciplina
NOT_CODES = {"CH", "TOTAL", "AULA", "AULAS", "NÃO", "NAO", "SIM", "PRÉ", "PRE", "EAD", "TCC"}


def limpa(x):
    return re.sub(r"\s+", " ", (x or "").replace("\n", " ")).strip()


def sem_acento(s):
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn").lower()


def acha_semestre(texto):
    """Devolve ('sem', n), ('opt', None) ou None, usando o ÚLTIMO título encontrado no texto."""
    found = None
    for m in re.finditer(SEM_RE, texto):
        found = ("sem", int(m.group(1)), m.start())
    for m in re.finditer(SEM_RE2, texto):
        if found is None or m.start() > found[2]:
            found = ("sem", int(m.group(1)), m.start())
    for m in re.finditer(OPT_RE, texto):
        if found is None or m.start() > found[2]:
            found = ("opt", None, m.start())
    return found[:2] if found else None


def eh_codigo(cel):
    return bool(CODE_RE.match(cel)) and cel not in NOT_CODES


def indices_cabecalho(linhas):
    """Procura a linha de cabeçalho e devolve (idx_pre, idx_aulas) ou None para cada um."""
    for row in linhas[:3]:
        cels = [sem_acento(limpa(c)) for c in row]
        pre = next((i for i, c in enumerate(cels) if "requisito" in c or c.startswith("pre")), None)
        aulas = None
        for i, c in enumerate(cels):
            if "aula" in c and ("seman" in c or "/sem" in c or c.strip() == "aulas"):
                aulas = i
                break
        if aulas is None:
            aulas = next((i for i, c in enumerate(cels) if "aula" in c), None)
        if pre is not None or aulas is not None:
            return pre, aulas
    return None, None


def parse_linha(cels, idx_pre, idx_aulas):
    """Interpreta uma linha de tabela. Devolve dict ou None se não for uma disciplina."""
    cels = [limpa(c) for c in cels]
    ic = next((i for i, c in enumerate(cels) if eh_codigo(c)), None)
    if ic is None:
        return None
    codigo = cels[ic]
    nome = next((c for c in cels[ic + 1:] if c and not c.isdigit()), "")
    if not nome:
        return None

    # aulas semanais
    aulas = None
    if idx_aulas is not None and idx_aulas < len(cels):
        m = re.search(r"\d+", cels[idx_aulas])
        aulas = int(m.group()) if m else None
    if aulas is None:
        for c in cels[ic + 1:]:
            if c.isdigit() and 1 <= int(c) <= 10:
                aulas = int(c)
                break

    # pré-requisitos (texto cru; a conversão nome -> código é feita depois)
    if idx_pre is not None and idx_pre < len(cels):
        pre_txt = cels[idx_pre]
    else:
        pre_txt = " ".join(c for c in cels[ic + 1:] if c != nome and not c.isdigit())
    return {"codigo": codigo, "nome": nome, "aulas": aulas, "pre_txt": pre_txt}


def extrai_disciplinas(pdf_path, debug=False):
    discs, sem_atual = [], None
    with pdfplumber.open(pdf_path) as pdf:
        for pn, page in enumerate(pdf.pages, 1):
            tabelas = page.find_tables()
            topo_prev = 0
            for t in sorted(tabelas, key=lambda t: t.bbox[1]):
                x0, top, x1, bottom = t.bbox
                if top > topo_prev:
                    try:
                        acima = page.within_bbox((0, topo_prev, page.width, top)).extract_text() or ""
                    except Exception:
                        acima = ""
                    s = acha_semestre(acima)
                    if s:
                        sem_atual = s
                topo_prev = bottom
                linhas = t.extract()
                idx_pre, idx_aulas = indices_cabecalho(linhas)
                if debug:
                    print(f"[pág {pn}] tabela com {len(linhas)} linhas | semestre={sem_atual} "
                          f"| col. pré={idx_pre} col. aulas={idx_aulas}", file=sys.stderr)
                for row in linhas:
                    junto = " ".join(limpa(c) for c in row)
                    # título de semestre dentro da própria tabela
                    if not any(eh_codigo(limpa(c)) for c in row):
                        s = acha_semestre(junto)
                        if s:
                            sem_atual = s
                        continue
                    d = parse_linha(row, idx_pre, idx_aulas)
                    if not d:
                        continue
                    d["sem_info"] = sem_atual
                    d["pagina"] = pn
                    discs.append(d)
                    if debug:
                        print(f"   {d['codigo']:6} sem={sem_atual} aulas={d['aulas']} "
                              f"pre='{d['pre_txt']}' | {d['nome']}", file=sys.stderr)
    return discs


def monta_raw(discs, ext_codes, sem_optativa, manter_ordem):
    vistos, unicos = set(), []
    for d in discs:
        if d["codigo"] in vistos:
            print(f"Aviso: código repetido ignorado: {d['codigo']} (pág {d['pagina']})", file=sys.stderr)
            continue
        vistos.add(d["codigo"])
        unicos.append(d)

    codigos = {d["codigo"] for d in unicos}
    por_nome = {sem_acento(d["nome"]): d["codigo"] for d in unicos}

    raw = []
    for d in unicos:
        # pré-requisitos: primeiro por código, depois por nome por extenso
        achados = CODE_IN_TEXT.findall(d["pre_txt"])
        pres = [c for c in achados if c in codigos and c != d["codigo"]]
        for c in achados:
            if c not in codigos and c not in NOT_CODES:
                print(f"Aviso: pré-requisito '{c}' de {d['codigo']} não existe na lista de disciplinas", file=sys.stderr)
        if not achados and d["pre_txt"] and d["pre_txt"] not in ("-", "—", "–", "Não há", "Nao ha"):
            txt = sem_acento(d["pre_txt"])
            pedacos = [p.strip() for p in re.split(r"[;,/]| e ", txt) if len(p.strip()) >= 6]
            for nm, cod in por_nome.items():
                if cod == d["codigo"]:
                    continue
                # nome inteiro dentro do texto, ou texto (cortado pelo PDF) no começo do nome
                if nm in txt or any(nm.startswith(p) for p in pedacos):
                    pres.append(cod)
        pres = list(dict.fromkeys(pres))  # sem duplicados, mantendo a ordem

        info = d["sem_info"]
        nome = d["nome"]
        if info and info[0] == "opt":
            sem = sem_optativa
            if "optativ" not in sem_acento(nome):
                nome += " (optativa)"
        elif info:
            sem = info[1]
        else:
            sem = 0
            print(f"Aviso: semestre não identificado para {d['codigo']} (ficou 0)", file=sys.stderr)

        ext = 1 if (d["codigo"] in ext_codes
                    or any(d["codigo"].startswith(p) for p in ext_codes if len(p) < len(d["codigo"]))
                    or "extens" in sem_acento(nome)) else 0
        raw.append([d["codigo"], nome, sem, d["aulas"] if d["aulas"] is not None else 0, ext, pres])
        if d["aulas"] is None:
            print(f"Aviso: aulas não identificadas para {d['codigo']} (ficou 0)", file=sys.stderr)

    if not manter_ordem:
        raw.sort(key=lambda r: (r[2], sem_acento(r[1])))
    return raw


def formata(raw):
    linhas = [json.dumps(r, ensure_ascii=False) for r in raw]
    return '"raw": [\n  ' + ",\n  ".join(linhas) + "\n]"


def main():
    ap = argparse.ArgumentParser(description="Lê o PPC (PDF) e gera o bloco \"raw\" de disciplinas.")
    ap.add_argument("pdf")
    ap.add_argument("-o", "--out", help="arquivo de saída (padrão: imprime na tela)")
    ap.add_argument("--ext-codes", default="EXT,PRI",
                    help="códigos/prefixos marcados como extensão=1 (padrão: EXT,PRI). Ex.: EXT,PRI,CSOC")
    ap.add_argument("--sem-optativa", type=int, default=10, help="semestre atribuído às optativas (padrão: 10)")
    ap.add_argument("--manter-ordem", action="store_true", help="não reordenar por semestre/nome")
    ap.add_argument("--debug", action="store_true", help="mostra o que foi lido de cada tabela")
    a = ap.parse_args()

    discs = extrai_disciplinas(a.pdf, a.debug)
    if not discs:
        sys.exit("Nenhuma disciplina encontrada. O PDF pode ser escaneado (imagem) ou ter as "
                 "tabelas em outro formato. Rode com --debug ou me envie o PDF para ajustar.")
    ext = {c.strip() for c in a.ext_codes.split(",") if c.strip()}
    raw = monta_raw(discs, ext, a.sem_optativa, a.manter_ordem)
    saida = formata(raw)
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(saida + "\n")
        print(f"{len(raw)} disciplinas salvas em {a.out}", file=sys.stderr)
    else:
        print(saida)


if __name__ == "__main__":
    main()