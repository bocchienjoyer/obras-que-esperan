"""Convierte el Anexo 1 de Contraloría de junio de 2026 en datos para el sitio."""

import argparse
import hashlib
import json
import math
from datetime import date
from io import BytesIO
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import urlopen

from openpyxl import load_workbook

FUENTE = "https://www.gob.pe/institucion/contraloria/informes-publicaciones/8489152-informe-de-obras-paralizadas-en-el-territorio-nacional-a-junio-de-2026"
ANEXO = "https://cdn.www.gob.pe/uploads/document/file/10466637/8489152-anexo-n-01-base-de-datos-con-la-lista-de-obras-publicas-paralizadas-en-el-territorio-nacional.XLSX?v=1787003153"
SHA256 = "aee166f5f864722222b67f4e36926c05308efaecba1db81f3652d926e1d30b35"
SALIDA = Path(__file__).resolve().parents[1] / "dist" / "obras.js"


def texto(valor):
    if valor is None:
        return None
    if isinstance(valor, date):
        return valor.strftime("%Y-%m-%d")
    return " ".join(str(valor).split()) or None


def codigo(valor):
    return str(int(valor)) if isinstance(valor, (int, float)) and valor > 0 else None


def numero(valor):
    return valor if isinstance(valor, (int, float)) and math.isfinite(valor) else None


def documento(valor):
    url = texto(valor)
    if url:
        parsed = urlsplit(url)
        if parsed.scheme == "https" and parsed.netloc == "ofi5.mef.gob.pe":
            return url
    return None


def preparar(contenido):
    if hashlib.sha256(contenido).hexdigest() != SHA256:
        raise ValueError("El archivo difiere del Anexo 1 verificado de junio de 2026.")
    libro = load_workbook(BytesIO(contenido), read_only=True, data_only=True)
    registros = []
    try:
        filas = iter(libro["Data"].values)
        next(filas)
        for fila_excel, fila in enumerate(filas, start=2):
            registros.append({
                "fila": fila_excel, "infobras": codigo(fila[1]), "cui": codigo(fila[2]),
                "obra": texto(fila[5]), "entidad": texto(fila[6]),
                "modalidad": texto(fila[8]), "costo": numero(fila[9]),
                "pim": numero(fila[14]), "tipo": texto(fila[16]),
                "departamento": texto(fila[19]), "provincia": texto(fila[20]),
                "distrito": texto(fila[21]), "inicio": numero(fila[22]),
                "avance": numero(fila[24]), "nivel": texto(fila[26]),
                "sector": texto(fila[27]), "causa": texto(fila[28]),
                "organo": texto(fila[29]), "inventarioMef": texto(fila[30]),
                "fechaInforme": texto(fila[33]), "informe": documento(fila[34]),
                "priorizada": texto(fila[35]), "fechaResolucion": texto(fila[36]),
                "resolucion": documento(fila[37]),
            })
    finally:
        libro.close()
    identificadores = {obra["infobras"] for obra in registros}
    if len(registros) != 2262 or len(identificadores) != 2262 or None in identificadores:
        raise ValueError("El inventario debe contener 2262 códigos INFOBRAS distintos.")
    return {"corte": "2026-06-30", "fuente": FUENTE, "anexo": ANEXO, "obras": registros}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("anexo", type=Path, nargs="?", help="Copia local del anexo oficial.")
    args = parser.parse_args()
    if args.anexo:
        contenido = args.anexo.read_bytes()
    else:
        with urlopen(ANEXO, timeout=30) as respuesta:
            contenido = respuesta.read()
    datos = preparar(contenido)
    SALIDA.write_text(
        "globalThis.INVENTARIO = " + json.dumps(datos, ensure_ascii=False, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )
    print(f'{len(datos["obras"])} obras importadas.')
