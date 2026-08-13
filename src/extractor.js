// src/extractor.js
import { PDFExtract } from 'pdf.js-extract';
import tesseract from 'tesseract.js';
import * as pdf2img from 'pdf-img-convert';

const { Tesseract } = tesseract;
const pdfExtract = new PDFExtract();

export async function extrairTextoPDF(filePath) {
    const data = await pdfExtract.extract(filePath, {});
    let paginas = [];
    
    (data.pages || []).forEach((page, index) => {
        let items = page.content || [];
        if (items.length === 0) return;

        // Ordena por Y (altura) e X (largura)
        items.sort((a, b) => {
            if (Math.abs(a.y - b.y) < 6) { // Tolerância de 6px na linha
                return a.x - b.x; 
            }
            return a.y - b.y;
        });

        let linhas = [];
        let currentLine = [];
        let currentY = items[0]?.y || 0;

        items.forEach(item => {
            if (!item.str || item.str.trim() === '') return;

            if (Math.abs(item.y - currentY) > 6) { 
                if (currentLine.length > 0) {
                    linhas.push(currentLine.join(' '));
                }
                currentLine = [item.str.trim()];
                currentY = item.y;
            } else {
                currentLine.push(item.str.trim());
            }
        });
        if (currentLine.length > 0) {
            linhas.push(currentLine.join(' '));
        }

        const numeroPagina = page?.pageInfo?.num || (index + 1);
        paginas.push({ page: numeroPagina, linhas: linhas });
    });

    if (paginas.length > 0 && paginas.some(p => p.linhas.length > 0)) {
        console.log('✅ PDF Vetorial lido (separado por linhas).');
        return paginas;
    }

    console.log('⚠️ PDF Escaneado detectado. Iniciando OCR com Tesseract...');
    const paginasImagens = await pdf2img.convert(filePath);
    paginas = [];
    
    for (let i = 0; i < paginasImagens.length; i++) {
        const { data: { text } } = await Tesseract.recognize(paginasImagens[i], 'por');
        const linhasOCR = text.split('\n').filter(linha => linha.trim() !== '');
        paginas.push({ page: i + 1, linhas: linhasOCR });
    }

    return paginas;
}

export function estruturarDados(paginas, tipo) {
    if (tipo === 'ponto') {
        const resultado = { pages: [] };

        // Regex ultra flexível para pegar qualquer formato de data ou dia da semana
        const regexData = /\b(\d{1,2}\s*[\/\-\.]\s*\d{1,2}(?:\s*[\/\-\.]\s*\d{2,4})?|\d{1,2}\s*[-–\s]?\s*(?:DOM|SEG|TER|QUA|QUI|SEX|SAB|DOMINGO|SEGUNDA|TERCA|TERÇA|QUARTA|QUINTA|SEXTA|SABADO|SÁBADO))\b/i;

        paginas.forEach(pagina => {
            const pageObj = { page: pagina.page, days: [] };
            const linhas = pagina.linhas || [];

            console.log(`\n--- 📄 ANALISANDO PÁGINA ${pagina.page} (${linhas.length} linhas encontradas) ---`);

            linhas.forEach(linha => {
                // Junta fragmentos que o PDF picotou com espaço extra (ex: "08 : 25" vira "08:25")
                const linhaNormalizada = linha.replace(/(\d{1,2})\s*([:;.,])\s*(\d{2})/g, '$1:$3');

                const dataMatch = linhaNormalizada.match(regexData);
                
                if (dataMatch) {
                    const date_raw = dataMatch[1].trim();

                    // Descarta se for assinatura ou rodapé
                    if (linhaNormalizada.includes('6b8cdfa') || linhaNormalizada.toLowerCase().includes('assinado')) {
                        return; 
                    }

                    // Extrai horários no formato HH:MM (ou com erros de OCR)
                    const horasMatch = linhaNormalizada.match(/\b([0-9a-zA-Z]{1,2}[:;.,][0-9a-zA-Z]{2})\b/g) || [];

                    const punches = horasMatch.map((horaBruta, index) => {
                        let limpo = horaBruta.replace(/[;.,]/g, ':').replace(/[^0-9:]/g, '?');
                        
                        if (limpo.length === 4 && limpo.includes(':')) {
                            limpo = '0' + limpo;
                        }

                        return {
                            kind: index % 2 === 0 ? "IN" : "OUT",
                            time_raw: horaBruta,
                            time_hhmm: limpo
                        };
                    });

                    console.log(`  🟢 Dia Encontrado: "${date_raw}" | Batidas:`, punches.map(p => p.time_hhmm));

                    pageObj.days.push({
                        date_raw: date_raw,
                        punches: punches
                    });
                }
            });

            resultado.pages.push(pageObj);
        });

        return resultado;
    }

    if (tipo === 'holerite') {
        return { pages: [] }; 
    }
}