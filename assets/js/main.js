import { extractLines, linhasParaDisciplinas, buildRaw, formatRaw } from "./script.js";

const $ = id => document.getElementById(id);
pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

let ultimoBuffer = null;
let ultimasLinhas = [];

async function processar() {
    if (!ultimoBuffer) return;
    $("status").textContent = "Lendo o PDF…";
    try {
        if (!ultimasLinhas.length) ultimasLinhas = await extractLines(pdfjsLib, ultimoBuffer.slice(0));
        const discs = linhasParaDisciplinas(ultimasLinhas);
        if (!discs.length) {
            throw new Error("Nenhuma disciplina encontrada. Veja o texto lido do PDF para entender o formato.");
        }
        const { raw, avisos } = buildRaw(discs, {
            extCodes: $("optExt").value.split(",").map(s => s.trim()).filter(Boolean),
            semOptativa: +$("optSem").value || 10,
            manterOrdem: $("optOrdem").checked
        });
        $("out").value = formatRaw(raw);
        $("avisos").innerHTML = "";
        avisos.forEach(a => { const li = document.createElement("li"); li.textContent = a; $("avisos").appendChild(li); });
        $("debug").textContent = ultimasLinhas.map(l => `p${l.page}  ` + l.cells.map(c => c.text).join("  |  ")).join("\n");
        $("result").hidden = false;
        $("status").textContent = `✓ ${raw.length} disciplinas encontradas` + (avisos.length ? ` · ${avisos.length} aviso(s)` : "");
    } catch (err) {
        $("status").textContent = "⚠️ " + err.message;
        if (ultimasLinhas.length) {
            $("debug").textContent = ultimasLinhas.map(l => `p${l.page}  ` + l.cells.map(c => c.text).join("  |  ")).join("\n");
            $("result").hidden = false;
            $("out").value = "";
            $("avisos").innerHTML = "";
        }
    }
}

async function carregar(file) {
    if (!file || !/pdf$/i.test(file.type || file.name)) {
        $("status").textContent = "⚠️ Escolha um arquivo PDF.";
        return;
    }
    ultimoBuffer = await file.arrayBuffer();
    ultimasLinhas = [];
    await processar();
}

const drop = $("drop");
drop.onclick = () => $("file").click();
drop.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("file").click(); } };
$("file").onchange = e => carregar(e.target.files[0]);
drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); carregar(e.dataTransfer.files[0]); };

["optExt", "optSem", "optOrdem"].forEach(id => { $(id).onchange = processar; });

$("btnCopy").onclick = async () => {
    try {
        await navigator.clipboard.writeText($("out").value);
        $("status").textContent = "✓ Copiado!";
    } catch {
        $("out").select();
        $("status").textContent = "Selecione e copie com Ctrl+C.";
    }
};
$("btnDown").onclick = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([$("out").value], { type: "application/json" }));
    a.download = "raw.json";
    a.click();
    URL.revokeObjectURL(a.href);
};
$("btnDebug").onclick = () => { $("debug").hidden = !$("debug").hidden; };