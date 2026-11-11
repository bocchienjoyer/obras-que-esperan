from datetime import date
from io import BytesIO
from pathlib import Path
import sys
import unittest

from openpyxl import Workbook

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from actualizar_inventario import COLECCION, actualizar, localizar_anexo, localizar_corte
from preparar_datos import CAMPOS, FUENTE, preparar

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
