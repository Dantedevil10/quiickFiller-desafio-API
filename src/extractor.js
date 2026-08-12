// src/extractor.js
import { PDFExtract } from 'pdf.js-extract';
import tesseract from 'tesseract.js';
const {Tesseract} = tesseract
import * as pdf2img from 'pdf-img-convert';
const pdfExtract = new PDFExtract();

export async function extrairTextoPDF(filePath) {
    // 1. TENTA LER COMO TEXTO VETORIAL (Rápido)
    const data = await pdfExtract.extract(filePath, {});
    let textoExtraido = '';
    
    data.pages.forEach(page => {
        page.content.forEach(item => {
            textoExtraido += item.str + ' ';
        });
    });

    // Se achou texto o suficiente, o PDF é digital. Retorna o texto.
    if (textoExtraido.trim().length > 50) {
        console.log('✅ PDF Vetorial lido com sucesso.');
        return textoExtraido;
    }

    // 2. FALLBACK: É UM PDF ESCANEADO (Imagem) -> Aciona o OCR
    console.log('⚠️ PDF Escaneado detectado. Iniciando conversão para imagem e OCR (Pode demorar)...');
    let textoOcr = '';
    
    // Converte o PDF para imagens (um array de buffers para cada página)
    const paginasImagens = await pdf2img.convert(filePath);
    
    for (let i = 0; i < paginasImagens.length; i++) {
        // Roda o Tesseract em cada página em português
        const { data: { text } } = await Tesseract.recognize(paginasImagens[i], 'por');
        textoOcr += text + '\n';
    }

    return textoOcr;
}

// Simula a estruturação do texto bruto para JSON baseado no tipo
export function estruturarDados(texto, tipo) {
    // Aqui no mundo real você usaria Expressões Regulares (Regex) para achar os dados específicos no texto bruto.
    // Para o desafio, vamos simular uma resposta estruturada que inclui nosso validador de erros.
    
    if (tipo === 'holerite') {
        return [
            { campo: 'Salario Base', valor: 3000, hasError: false },
            { campo: 'Desconto INSS', valor: 300, hasError: false },
            { campo: 'Salario Liquido', valor: 2700, hasError: false } // 3000 - 300 (Correto)
        ];
    }

    if (tipo === 'ponto') {
        return [
            { campo: 'Entrada', valor: '08:00', hasError: false },
            { campo: 'Saida', valor: '18:00', hasError: false },
            // Simulando um erro de leitura para o Angular mostrar em vermelho
            { campo: 'Total Horas', valor: '12:00', hasError: true, reason: 'Cálculo de horas não bate' } 
        ];
    }
}

//module.exports = { extrairTextoPDF, estruturarDados };