"""Reproduce el corte inicial o importa un inventario nacional de Contraloría."""

import argparse
import hashlib
import json
import math
import re
from datetime import date
from io import BytesIO
from pathlib import Path
from tempfile import NamedTemporaryFile
from urllib.parse import urlsplit
from urllib.request import urlopen
from unicodedata import normalize
from zipfile import BadZipFile, ZipFile

from openpyxl import load_workbook
from openpyxl.utils.datetime import from_excel

FUENTE = "https://www.gob.pe/institucion/contraloria/informes-publicaciones/8489152-informe-de-obras-paralizadas-en-el-territorio-nacional-a-junio-de-2026"
ANEXO = "https://cdn.www.gob.pe/uploads/document/file/10466637/8489152-anexo-n-01-base-de-datos-con-la-lista-de-obras-publicas-paralizadas-en-el-territorio-nacional.XLSX?v=1787003153"
SHA256 = "aee166f5f864722222b67f4e36926c05308efaecba1db81f3652d926e1d30b35"
SALIDA = Path(__file__).resolve().parents[1] / "dist" / "obras.js"
PREFIJO = "globalThis.INVENTARIO = "
CAMPOS = {
    "fila_oficial": "n", "infobras": "codigo infobras", "cui": "cui",
    "obra": "descripcion obra", "entidad": "entidad", "modalidad": "modalidad de ejecucion",
    "costo": "costo de obra segun exp tec segun infobras s", "tipo": "tipo de obra",
    "categoria": "tipo de obra nivel 2", "subtipo": "tipo de obra nivel 3",
    "departamento": "departamento", "provincia": "provincia", "distrito": "distrito",
    "inicio": "ano inicio obra", "avance": "avance fisico", "nivel": "nivel de gobierno",
    "sector": "sector", "causa": "causal paralizacion", "organo": "unidad organica",
    "inventarioMef": "esta en el inventario obras paralizadas mef",
    "fechaInforme": "fecha informe situacional", "informe": "url informe",
    "priorizada": "dentro de la lista priorizada",
    "fechaResolucion": "fecha resolucion de lista priorizada", "resolucion": "url resolucion",
}
MAX_FILAS = 50_000
MAX_COLUMNAS = 128
MAX_XLSX_DESCOMPRIMIDO = 64 * 1024 * 1024


def texto(valor):
    if valor is None:
        return None
    if isinstance(valor, date):
        return valor.strftime("%Y-%m-%d")
    return " ".join(str(valor).split()) or None


def codigo(valor):
    if isinstance(valor, str) and valor.strip().isascii() and valor.strip().isdecimal():
        valor = int(valor)
    if type(valor) in (int, float) and math.isfinite(valor) and valor > 0 and int(valor) == valor:
        return str(int(valor))
    return None


def numero(valor):
    return valor if isinstance(valor, (int, float)) and math.isfinite(valor) else None


def fecha(valor, epoca):
    if isinstance(valor, (int, float)):
        valor = from_excel(valor, epoch=epoca)
    return texto(valor)


def documento(valor):
    url = texto(valor)
    if url:
        parsed = urlsplit(url)
        if parsed.scheme == "https" and parsed.netloc == "ofi5.mef.gob.pe":
            return url
    return None


def normalizar(valor):
    plano = normalize("NFD", texto(valor) or "").encode("ascii", "ignore").decode().lower()
    return " ".join(re.findall(r"[a-z0-9]+", plano))


def columnas(encabezados):
    normalizados = [normalizar(valor) for valor in encabezados]
    indices = {}
    for campo, titulo in CAMPOS.items():
        if normalizados.count(titulo) != 1:
            raise ValueError(f"Columna ausente o ambigua: {titulo}.")
        indices[campo] = normalizados.index(titulo)
    pim = [(i, h[-4:]) for i, h in enumerate(normalizados) if re.fullmatch(r"pim 20\d{2}", h)]
    if len(pim) != 1:
        raise ValueError("La columna PIM con año es ausente o ambigua.")
    indices["pim"], anio = pim[0]
    return indices, int(anio)


def preparar(contenido, corte, fuente, anexo):
    try:
        with ZipFile(BytesIO(contenido)) as comprimido:
            if sum(entrada.file_size for entrada in comprimido.infolist()) > MAX_XLSX_DESCOMPRIMIDO:
                raise ValueError("El anexo supera el tamaño descomprimido permitido.")
    except BadZipFile as error:
        raise ValueError("El archivo descargado no es un XLSX válido.") from error
    libro = load_workbook(BytesIO(contenido), read_only=True, data_only=True)
    registros = []
    try:
        candidatas = []
        for hoja in libro:
            if (hoja.max_row or 0) > MAX_FILAS + 1 or (hoja.max_column or 0) > MAX_COLUMNAS:
                raise ValueError("El anexo excede las dimensiones esperadas para el inventario.")
            filas = iter(hoja.values)
            try:
                indices, anio_pim = columnas(next(filas, ()))
            except ValueError:
                continue
            candidatas.append((filas, indices, anio_pim))
        if len(candidatas) != 1:
            raise ValueError("Se esperaba una sola hoja con la estructura del inventario nacional.")
        filas, indices, anio_pim = candidatas[0]
        if abs(anio_pim - corte.year) > 1:
            raise ValueError("El año del PIM no corresponde al periodo del informe.")
        codigos = set()
        fin = False
        for fila_excel, fila in enumerate(filas, start=2):
            if fila_excel > MAX_FILAS + 1 or len(fila) > MAX_COLUMNAS:
                raise ValueError("El anexo excede las dimensiones esperadas para el inventario.")
            if not any(texto(valor) is not None for valor in fila):
                fin = True
                continue
            datos = {campo: fila[indice] for campo, indice in indices.items()}
            infobras = codigo(datos["infobras"])
            if (fin or codigo(datos["fila_oficial"]) != str(len(registros) + 1)
                    or not infobras or infobras in codigos):
                raise ValueError(f"Identificador o secuencia inválida en la fila {fila_excel}.")
            if not all(texto(datos[campo]) for campo in ("obra", "entidad", "departamento")):
                raise ValueError(f"Faltan datos obligatorios en la fila {fila_excel}.")
            avance = numero(datos["avance"])
            if datos["avance"] is not None and (avance is None or not 0 <= avance <= 100):
                raise ValueError(f"Avance físico inválido en la fila {fila_excel}.")
            for campo in ("pim", "costo"):
                monto = numero(datos[campo])
                if datos[campo] is not None and (monto is None or monto < 0):
                    raise ValueError(f"Monto inválido en la fila {fila_excel}, campo {campo}.")
            cui = codigo(datos["cui"])
            if datos["cui"] not in (0, "0", None, "") and not cui:
                raise ValueError(f"CUI inválido en la fila {fila_excel}.")
            codigos.add(infobras)
            registros.append({
                "fila": fila_excel, "infobras": infobras, "cui": cui,
                **{campo: texto(datos[campo]) for campo in (
                    "obra", "entidad", "modalidad", "tipo", "categoria", "subtipo",
                    "departamento", "provincia", "distrito", "nivel", "sector",
                    "causa", "organo", "inventarioMef", "priorizada",
                )},
                "costo": numero(datos["costo"]), "pim": numero(datos["pim"]), "avance": avance,
                "inicio": texto(datos["inicio"]) if isinstance(datos["inicio"], str) else numero(datos["inicio"]),
                "fechaInforme": fecha(datos["fechaInforme"], libro.epoch),
                "fechaResolucion": fecha(datos["fechaResolucion"], libro.epoch),
                "informe": documento(datos["informe"]), "resolucion": documento(datos["resolucion"]),
            })
    finally:
        libro.close()
    if not registros:
        raise ValueError("El inventario está vacío.")
    return {
        "corte": corte.isoformat(), "fuente": fuente, "anexo": anexo, "anioPim": anio_pim,
        "sha256": hashlib.sha256(contenido).hexdigest(), "obras": registros,
    }


def leer_inventario():
    return json.loads(SALIDA.read_text(encoding="utf-8").removeprefix(PREFIJO).strip().removesuffix(";"))


def guardar(datos):
    temporal = None
    try:
        with NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n", dir=SALIDA.parent,
                                prefix=".inventario-", suffix=".tmp", delete=False) as archivo:
            temporal = Path(archivo.name)
            archivo.write(PREFIJO)
            json.dump(datos, archivo, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            archivo.write(";\n")
        temporal.replace(SALIDA)
    finally:
        if temporal:
            temporal.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("anexo", type=Path, nargs="?", help="Copia local del anexo oficial.")
    args = parser.parse_args()
    if args.anexo:
        contenido = args.anexo.read_bytes()
    else:
        with urlopen(ANEXO, timeout=30) as respuesta:
            contenido = respuesta.read()
    if hashlib.sha256(contenido).hexdigest() != SHA256:
        raise ValueError("El archivo difiere del anexo inicial verificado de junio de 2026.")
    datos = preparar(contenido, date(2026, 6, 30), FUENTE, ANEXO)
    if len(datos["obras"]) != 2262:
        raise ValueError("El corte inicial debe contener 2262 obras.")
    if SALIDA.exists() and leer_inventario()["corte"] > datos["corte"]:
        raise ValueError("Ya existe un corte más reciente. Usa scripts/actualizar_inventario.py.")
    guardar(datos)
    print(f'{len(datos["obras"])} obras importadas.')
