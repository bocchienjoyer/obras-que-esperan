const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { readFile } = require("node:fs/promises");
const { resolve } = require("node:path");
const { createInterface } = require("node:readline");
const { pathToFileURL } = require("node:url");
const { after, before, test } = require("node:test");
const { chromium } = require(process.env.OBRAS_PLAYWRIGHT || "playwright");

const local = pathToFileURL(resolve(__dirname, "../dist/index.html")).href;
let browser;

before(async () => {
  const executablePath = process.env.OBRAS_BROWSER;
  browser = await chromium.launch(executablePath ? { executablePath } : {});
});

after(async () => {
  await browser?.close();
});

async function probar(navegar) {
  const pagina = await browser.newPage({
    viewport: { width: 1360, height: 920 },
    acceptDownloads: true,
  });
  const errores = [];
  pagina.on("pageerror", error => errores.push(error.message));
  try {
    await navegar(pagina);
    assert.deepEqual(errores, []);
  } finally {
    await pagina.close();
  }
}

async function esperarConteo(pagina, total) {
  await pagina.waitForFunction(n => {
    const conteo = document.querySelector("#conteo").textContent;
    return conteo.split(" ")[0].replace(/\D/g, "") === String(n);
  }, total);
}

test("coinciden la consulta territorial, el total y el CSV", () => probar(async pagina => {
  await pagina.goto(local);
  await esperarConteo(pagina, 2262);
  await pagina.selectOption("#dep", "CUSCO");
  await esperarConteo(pagina, 370);
  await pagina.selectOption("#prov", "LA CONVENCION");
  await esperarConteo(pagina, 92);
  await pagina.selectOption("#dist", "ECHARATE");
  await esperarConteo(pagina, 47);
  const [descarga] = await Promise.all([pagina.waitForEvent("download"), pagina.click("#descargar")]);
  const csv = await readFile(await descarga.path(), "utf8");
  const filas = csv.trimEnd().split(/\r?\n/);
  assert.equal(filas.length, 48);
  assert.ok(filas.slice(1).every(fila => fila.includes('"CUSCO","LA CONVENCION","ECHARATE"')));
  assert.ok(filas.slice(1).every(fila => fila.includes('"2026-06-30"')));
  await pagina.click("#limpiar");
  await pagina.fill("#q", "¿Cuántas obras paralizadas hay en Echarate?");
  await esperarConteo(pagina, 47);
  await pagina.fill("#q", "¿Cuáles son las obras públicas paralizadas en La Convención?");
  await esperarConteo(pagina, 92);
  await pagina.fill("#q", "colegio en Cusco");
  assert.ok(await pagina.locator(".resultado").count() > 0);
  await pagina.click("#limpiar");
  await pagina.selectOption("#avance", "100");
  await esperarConteo(pagina, 23);
  await pagina.selectOption("#avance", "sin");
  await esperarConteo(pagina, 54);
}));

test("distingue identificadores y conserva la búsqueda al volver de una ficha", () => probar(async pagina => {
  await pagina.goto(local + "?q=CUI+59");
  await esperarConteo(pagina, 0);
  assert.ok(await pagina.locator("#descargar").isDisabled());
  await pagina.fill("#q", "INFOBRAS 59");
  await esperarConteo(pagina, 1);
  await pagina.locator("#lista h3 a").click();
  await pagina.locator("#ficha[open]").waitFor();
  assert.match(await pagina.locator("#detalle").innerText(), /PROGRAMA SUBSECTORIAL DE IRRIGACIONES/);
  await pagina.goBack();
  await pagina.locator("#ficha[open]").waitFor({ state: "hidden" });
  await esperarConteo(pagina, 1);
  assert.equal(await pagina.locator("#q").inputValue(), "INFOBRAS 59");
  await pagina.goForward();
  await pagina.locator("#ficha[open]").waitFor();
  await pagina.getByRole("button", { name: "Cerrar", exact: true }).click();
  await pagina.locator("#ficha[open]").waitFor({ state: "hidden" });
  await pagina.waitForFunction(() => !new URLSearchParams(location.search).has("obra"));
  await pagina.fill("#q", "CUI 2100376");
  await esperarConteo(pagina, 1);
}));

test("abre enlaces de ficha, conserva datos ausentes y funciona en móvil", () => probar(async pagina => {
  await pagina.setViewportSize({ width: 390, height: 844 });
  await pagina.goto(local + "?dep=CUSCO&prov=LA+CONVENCION&dist=ECHARATE&obra=5712");
  await pagina.locator("#ficha[open]").waitFor();
  assert.match(await pagina.locator("#detalle").innerText(), /100 %/);
  assert.match(await pagina.getByRole("link", { name: /Informe de estado situacional/ }).getAttribute("href"), /^https:\/\/ofi5\.mef\.gob\.pe\//);
  await pagina.locator("#ficha summary").click();
  assert.match(await pagina.locator("#pedido").inputValue(), /CUI 2161116/);
  assert.ok(await pagina.getByRole("button", { name: "Sugerir preguntas con IA" }).isHidden());
  await pagina.keyboard.press("Escape");
  await esperarConteo(pagina, 47);
  assert.ok(await pagina.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await pagina.goto(local + "?obra=558323");
  assert.match(await pagina.locator("#detalle").innerText(), /Sin CUI asociado/);
  await pagina.goto(local + "?q=sincoincidenciareal");
  await esperarConteo(pagina, 0);
  await pagina.click("#limpiar");
  await pagina.click("#siguiente");
  assert.match(await pagina.locator("#conteo").innerText(), /13–24/);
}));

test("añade sugerencias de Codex al borrador sin perder ediciones", {
  skip: !process.env.OBRAS_IA_REAL, timeout: 65000,
}, () => probar(async pagina => {
  const servidor = spawn(process.env.OBRAS_PYTHON || "python", ["servidor.py", "--puerto", "0"], {
    cwd: resolve(__dirname, ".."), stdio: ["ignore", "pipe", "inherit"],
  });
  const salida = createInterface({ input: servidor.stdout });
  try {
    const url = await new Promise((resolveURL, reject) => {
      servidor.once("error", reject);
      servidor.once("exit", () => reject(new Error("El servidor terminó antes de iniciar.")));
      salida.once("line", linea => {
        const coincidencia = linea.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (coincidencia) resolveURL(coincidencia[0]);
        else reject(new Error("No se encontró la dirección local."));
      });
    });
    await pagina.goto(url + "/?obra=5712");
    await pagina.locator("#ficha summary").click();
    await pagina.locator("#pedido").fill("Texto revisado por la persona usuaria.");
    await pagina.getByRole("button", { name: "Sugerir preguntas con IA" }).click();
    await pagina.getByText("Se añadieron tres preguntas.", { exact: false }).waitFor({ timeout: 55000 });
    const pedido = await pagina.locator("#pedido").inputValue();
    assert.match(pedido, /^Texto revisado por la persona usuaria\./);
    assert.equal(pedido.split("\n").filter(linea => /^\d\. /.test(linea)).length, 3);
  } finally {
    salida.close();
    servidor.kill();
  }
}));
