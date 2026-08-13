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

        // Tolerância aumentada para 8px para garantir que horários e datas na mesma "faixa" fiquem na mesma linha
        items.sort((a, b) => {
            if (Math.abs(a.y - b.y) < 8) { 
                return a.x - b.x; 
            }
            return a.y - b.y;
        });

        let linhas = [];
        let currentLine = [];
        let currentY = items[0]?.y || 0;

        items.forEach(item => {
            if (!item.str || item.str.trim() === '') return;

            if (Math.abs(item.y - currentY) > 8) { 
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

        paginas.forEach(pagina => {
            const pageObj = { page: pagina.page, days: [] };
            const linhas = pagina.linhas || [];

            let ultimoDiaEncontrado = null; // Memória para caso os horários caiam na linha de baixo

            linhas.forEach(linha => {
                // Junta fragmentos que o PDF picotou (ex: "08 : 25" vira "08:25")
                const linhaNormalizada = linha.replace(/(\d{1,2})\s*([:;.,])\s*(\d{2})/g, '$1:$3');

                // Ignora assinaturas digitais
                if (linhaNormalizada.includes('6b8cdfa') || linhaNormalizada.toLowerCase().includes('assinado')) {
                    return; 
                }

                // 1. EXTRAÇÃO DE DATA BLINDADA (Testa do mais completo para o mais simples)
                let date_raw = null;
                
                // Tenta achar DD/MM/YYYY primeiro
                const matchFull = linhaNormalizada.match(/(\d{1,2}\s*[\/\-\.]\s*\d{1,2}\s*[\/\-\.]\s*\d{2,4})/);
                if (matchFull) {
                    date_raw = matchFull[1].trim(); 
                } else {
                    // Tenta achar DD/MM
                    const matchShort = linhaNormalizada.match(/(\d{1,2}\s*[\/\-\.]\s*\d{1,2})/);
                    if (matchShort) {
                        date_raw = matchShort[1].trim();
                    } else {
                        // Tenta achar Dia e Semana (ex: 12 SEG)
                        const matchWk = linhaNormalizada.match(/(\d{1,2}\s*[-–\s]?\s*(?:DOM|SEG|TER|QUA|QUI|SEX|SAB|DOMINGO|SEGUNDA|TERCA|TERÇA|QUARTA|QUINTA|SEXTA|SABADO|SÁBADO))/i);
                        if (matchWk) {
                            date_raw = matchWk[1].trim();
                        }
                    }
                }

                // 2. EXTRAÇÃO DOS HORÁRIOS
                const horasMatch = linhaNormalizada.match(/\b([0-9a-zA-Z]{1,2}[:;.,][0-9a-zA-Z]{2})\b/g) || [];
                const punchesAtuais = horasMatch.map((horaBruta) => {
                    let limpo = horaBruta.replace(/[;.,]/g, ':').replace(/[^0-9:]/g, '?');
                    if (limpo.length === 4 && limpo.includes(':')) {
                        limpo = '0' + limpo;
                    }
                    return {
                        kind: "", // O Kind será calculado no próximo passo para nunca errar a ordem
                        time_raw: horaBruta,
                        time_hhmm: limpo
                    };
                });

                // 3. VÍNCULO DATA <-> HORÁRIO
                if (date_raw) {
                    // É uma linha nova com data! Cria o dia no array.
                    ultimoDiaEncontrado = {
                        date_raw: date_raw,
                        punches: punchesAtuais
                    };
                    pageObj.days.push(ultimoDiaEncontrado);
                } 
                else if (punchesAtuais.length > 0 && ultimoDiaEncontrado) {
                    // A linha NÃO tem data, mas tem horários. 
                    // Isso significa que o PDF separou as horas na linha de baixo. Adiciona ao dia anterior!
                    ultimoDiaEncontrado.punches.push(...punchesAtuais);
                }

                // 4. GARANTIA DO IN / OUT (Calculado com base no tamanho final do array do dia)
                if (ultimoDiaEncontrado) {
                    ultimoDiaEncontrado.punches.forEach((p, index) => {
                        p.kind = index % 2 === 0 ? "IN" : "OUT";
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