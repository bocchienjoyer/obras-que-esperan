from datetime import date
from io import BytesIO
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError, URLError

from openpyxl import Workbook

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from actualizar_inventario import COLECCION, actualizar, descargar, localizar_anexo, localizar_corte, revisar_archivo
from preparar_datos import CAMPOS, FUENTE, PREFIJO, guardar, preparar

HOY = date(2026, 11, 10)
NUEVO = "https://www.gob.pe/institucion/contraloria/informes-publicaciones/999-informe-de-obras-publicas-paralizadas-en-el-territorio-nacional-a-septiembre-de-2026"
ANEXO = "https://cdn.www.gob.pe/uploads/document/file/999/999-anexo-n-02-lista-de-obras-paralizadas-en-el-territorio-nacional.xlsx"
CONTROL = ANEXO.replace("lista-de-obras", "lista-de-servicios-de-control-a-obras")


def html(*enlaces):
    return "".join(f'<a href="{url}">Ver</a>' for url in enlaces).encode()


def xlsx(*, duplicado=False, avance=90, encabezado=True):
    libro = Workbook()
    hoja = libro.active
    hoja.title = "Inventario"
    columnas = list(reversed(CAMPOS))
    hoja.append(["PIM 2026", *(CAMPOS[campo] if encabezado or campo != "avance" else "avance alterado"
                               for campo in columnas)])
    for i in (1, 2):
        fila = {
            "fila_oficial": i, "infobras": 100 if duplicado else 100 + i,
            "cui": 2345678, "obra": f"Obra {i}", "entidad": "Entidad",
            "departamento": "CUSCO", "avance": avance, "costo": 1000,
        }
        hoja.append([100, *(fila.get(campo) for campo in columnas)])
    memoria = BytesIO()
    libro.save(memoria)
    return memoria.getvalue()


class ActualizacionTest(unittest.TestCase):
    def setUp(self):
        self.actual = {
            "corte": "2026-06-30", "fuente": FUENTE,
            "obras": [{"infobras": "15", "departamento": "CUSCO"}],
        }

    def obtener(self, *respuestas):
        fuentes = dict(respuestas)
        return lambda url, _: fuentes[url]

    def test_distingue_fecha_del_corte_y_enlace_oficial(self):
        futuro = NUEVO.replace("septiembre", "diciembre")
        falso = NUEVO.replace("www.gob.pe", "example.com")
        self.assertEqual(localizar_corte(html(FUENTE, NUEVO, futuro, falso).decode(), HOY),
                         (date(2026, 9, 30), NUEVO))
        self.assertEqual(localizar_anexo(NUEVO, html(ANEXO, CONTROL).decode()), ANEXO)

    def test_sin_nuevo_corte_solo_actualiza_la_revision(self):
        resultado = actualizar(self.actual, HOY, self.obtener((COLECCION, html(FUENTE))))
        self.assertEqual(resultado, {**self.actual, "revisado": "2026-11-10"})
        self.assertNotIn("revisado", self.actual)

    def test_importa_anexo_reordenado_y_reemplaza_metadatos(self):
        resultado = actualizar(self.actual, HOY, self.obtener(
            (COLECCION, html(FUENTE, NUEVO)), (NUEVO, html(ANEXO, CONTROL)), (ANEXO, xlsx()),
        ))
        self.assertEqual(resultado["corte"], "2026-09-30")
        self.assertEqual(resultado["anexo"], ANEXO)
        self.assertEqual(resultado["anioPim"], 2026)
        self.assertEqual([fila["infobras"] for fila in resultado["obras"]], ["101", "102"])

    def test_rechaza_anexos_ambiguos_y_datos_invalidos(self):
        with self.assertRaises(ValueError):
            localizar_anexo(NUEVO, html(ANEXO, ANEXO.replace("/999/", "/1000/")).decode())
        for invalido in (xlsx(duplicado=True), xlsx(avance=101), xlsx(encabezado=False)):
            with self.assertRaises(ValueError):
                preparar(invalido, date(2026, 9, 30), NUEVO, ANEXO)

    def test_rechaza_un_inventario_truncado(self):
        self.actual["obras"] *= 6
        with self.assertRaisesRegex(ValueError, "Cambio atípico"):
            actualizar(self.actual, HOY, self.obtener(
                (COLECCION, html(NUEVO)), (NUEVO, html(ANEXO)), (ANEXO, xlsx()),
            ))

    def test_fallo_de_red_o_xlsx_corrupto_dejan_el_archivo_intacto(self):
        original = PREFIJO + json.dumps(self.actual) + ";\n"

        def fuera_de_linea(url, limite):
            raise URLError("Sin conexión")

        with TemporaryDirectory() as carpeta:
            ruta = Path(carpeta) / "obras.js"
            ruta.write_bytes(original.encode())
            with patch("preparar_datos.SALIDA", ruta):
                with self.assertRaises(URLError):
                    revisar_archivo(HOY, obtener=fuera_de_linea)
                with self.assertRaisesRegex(ValueError, "XLSX"):
                    revisar_archivo(HOY, obtener=self.obtener(
                        (COLECCION, html(NUEVO)), (NUEVO, html(ANEXO)),
                        (ANEXO, b"<html>Servicio no disponible</html>"),
                    ))
            self.assertEqual(ruta.read_bytes(), original.encode())
            self.assertEqual(list(Path(carpeta).iterdir()), [ruta])

    def test_guardado_interrumpido_no_sobrescribe_el_inventario(self):
        with TemporaryDirectory() as carpeta:
            ruta = Path(carpeta) / "obras.js"
            ruta.write_bytes(b"corte verificado")
            with patch("preparar_datos.SALIDA", ruta), patch.object(Path, "replace", side_effect=PermissionError):
                with self.assertRaises(PermissionError):
                    guardar(self.actual)
            self.assertEqual(ruta.read_bytes(), b"corte verificado")
            self.assertEqual(list(Path(carpeta).iterdir()), [ruta])

    def test_reintenta_errores_transitorios_con_limite(self):
        fallo = HTTPError(COLECCION, 503, "No disponible", None, None)
        abridor = MagicMock()
        respuesta = abridor.open.return_value.__enter__.return_value
        respuesta.geturl.return_value = COLECCION
        respuesta.read.return_value = b"contenido oficial"
        abridor.open.side_effect = [fallo, fallo, abridor.open.return_value]
        with patch("actualizar_inventario.build_opener", return_value=abridor), patch("actualizar_inventario.sleep"):
            self.assertEqual(descargar(COLECCION, 100), b"contenido oficial")
            self.assertEqual(abridor.open.call_count, 3)
            abridor.open.reset_mock(side_effect=True)
            abridor.open.side_effect = fallo
            with self.assertRaises(HTTPError):
                descargar(COLECCION, 100)
            self.assertEqual(abridor.open.call_count, 3)

    def test_limita_el_tamano_descomprimido_y_las_columnas_del_xlsx(self):
        anexo = xlsx()
        for constante, valor in (("MAX_XLSX_DESCOMPRIMIDO", 5), ("MAX_COLUMNAS", 10), ("MAX_FILAS", 1)):
            with patch(f"preparar_datos.{constante}", valor):
                with self.assertRaises(ValueError):
                    preparar(anexo, date(2026, 9, 30), NUEVO, ANEXO)
