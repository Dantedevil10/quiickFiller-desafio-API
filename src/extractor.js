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

        // Tolerância para alinhar textos na mesma linha horizontal (Y)
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

            let ultimoDiaEncontrado = null; 

            linhas.forEach(linha => {
                const linhaTrim = linha.trim();

                // 0. FILTRO DE CABEÇALHO (Mês/Ano)
                if (/^\s*\d{1,2}\s*[\/\-\.]\s*\d{2,4}\s*$/.test(linhaTrim)) {
                    const partes = linhaTrim.split(/[\/\-\.]/).map(p => p.trim());
                    const n1 = parseInt(partes[0], 10);
                    const n2 = parseInt(partes[1], 10);
                    if (n1 >= 1 && n1 <= 12 && (n2 > 12 || partes[1].length === 4)) {
                        return; 
                    }
                }

                // 1. EXTRAÇÃO DE DATA BLINDADA
                let date_raw = null;
                
                const matchFull = linha.match(/(\d{1,2}\s*[\/\-\.]\s*\d{1,2}\s*[\/\-\.]\s*\d{2,4}(?:\s*[-–\s]?\s*(?:DOM|SEG|TER|QUA|QUI|SEX|SAB|DOMINGO|SEGUNDA|TERCA|TERÇA|QUARTA|QUINTA|SEXTA|SABADO|SÁBADO))?)/i);
                if (matchFull) {
                    date_raw = matchFull[1]; 
                } else {
                    const matchShort = linha.match(/(\d{1,2}\s*[\/\-\.]\s*(?:0?[1-9]|1[0-2])(?:\s*[-–\s]?\s*(?:DOM|SEG|TER|QUA|QUI|SEX|SAB|DOMINGO|SEGUNDA|TERCA|TERÇA|QUARTA|QUINTA|SEXTA|SABADO|SÁBADO))?)/i);
                    if (matchShort) {
                        date_raw = matchShort[1];
                    } else {
                        const matchWk = linha.match(/(\d{1,2}\s*[-–\s]?\s*(?:DOM|SEG|TER|QUA|QUI|SEX|SAB|DOMINGO|SEGUNDA|TERCA|TERÇA|QUARTA|QUINTA|SEXTA|SABADO|SÁBADO))/i);
                        if (matchWk) {
                            date_raw = matchWk[1];
                        }
                    }
                }

                let linhaParaHoras = linha;
                if (date_raw) {
                    linhaParaHoras = linhaParaHoras.replace(date_raw, '');
                }

                const linhaNormalizada = linhaParaHoras.replace(/(\d{1,2})\s*([:;.,])\s*(\d{2})/g, '$1:$3');

                if (linhaNormalizada.includes('6b8cdfa') || linhaNormalizada.toLowerCase().includes('assinado')) {
                    return; 
                }

                // 2. EXTRAÇÃO INTELIGENTE (Preparando o terreno para generalização)
                // Corta a string no primeiro bloco de texto maior que 2 letras (ex: "HE-BCO", "FALTA")
                // Isso automaticamente ignora colunas de saldo extra/atraso no final da linha.
                const stringSomenteHorarios = linhaNormalizada.split(/[a-zA-Z]{3,}/)[0];
                
                // Captura apenas horários bem formatados na zona limpa
                const horasMatch = stringSomenteHorarios.match(/\b\d{1,2}:\d{2}\b/g) || [];

                // A regra de layout genérico: O primeiro tempo colado na data é a carga horária base (Jornada)
                let horasParaProcessar = horasMatch;
                if (date_raw && horasMatch.length > 0) {
                    horasParaProcessar = horasMatch.slice(1);
                }

                const punchesAtuais = horasParaProcessar.map((horaBruta) => {
                    let limpo = horaBruta;
                    if (limpo.length === 4) { // Padroniza H:MM para HH:MM
                        limpo = '0' + limpo;
                    }
                    return {
                        kind: "", 
                        time_raw: horaBruta,
                        time_hhmm: limpo
                    };
                });

                // 3. VÍNCULO DATA <-> HORÁRIO
                if (date_raw) {
                    ultimoDiaEncontrado = {
                        date_raw: date_raw,
                        punches: punchesAtuais
                    };
                    pageObj.days.push(ultimoDiaEncontrado);
                } 
                else if (punchesAtuais.length > 0 && ultimoDiaEncontrado) {
                    ultimoDiaEncontrado.punches.push(...punchesAtuais);
                }

                // 4. GARANTIA DO IN / OUT
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