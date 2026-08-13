// src/extractor.js

import { PDFExtract } from 'pdf.js-extract';
import tesseract from 'tesseract.js';
import { pdf } from 'pdf-to-img';
import fs from 'fs';

const pdfExtract = new PDFExtract();

export async function extrairTextoPDF(filePath) {
    // Garante que o arquivo tenha extensão .pdf para bibliotecas externas
    let validPath = filePath;
    if (!filePath.endsWith('.pdf') && fs.existsSync(filePath)) {
        const newPath = filePath + '.pdf';
        fs.copyFileSync(filePath, newPath);
        validPath = newPath;
    }

    // 1. Tenta extração vetorial (padrão)
    try {
        const data = await pdfExtract.extract(validPath, {});
        let paginas = [];
        
        (data.pages || []).forEach((page, index) => {
            let items = page.content || [];
            if (items.length === 0) return;

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
            console.log('✅ PDF Vetorial lido com sucesso.');
            if (validPath !== filePath && fs.existsSync(validPath)) fs.unlinkSync(validPath);
            return paginas;
        }
    } catch (e) {
        console.log('⚠️ Extração vetorial falhou, convertendo PDF para imagem...');
    }

    // 2. OCR Usando pdf-to-img (Sua solução salvadora!)
    console.log('⚠️ Executando OCR via pdf-to-img + Tesseract...');
    try {
        const document = await pdf(validPath, { scale: 2 });
        let paginasOCR = [];
        let pageCounter = 1;

        for await (const imageBuffer of document) {
            const { data: { text } } = await tesseract.recognize(imageBuffer, 'por');
            const linhasOCR = text.split('\n').filter(linha => linha.trim() !== '');
            
            paginasOCR.push({
                page: pageCounter++,
                linhas: linhasOCR
            });
        }

        if (validPath !== filePath && fs.existsSync(validPath)) fs.unlinkSync(validPath);
        return paginasOCR;
    } catch (ocrError) {
        if (validPath !== filePath && fs.existsSync(validPath)) fs.unlinkSync(validPath);
        console.error('Erro crítico no OCR com pdf-to-img:', ocrError);
        throw ocrError;
    }
}

export function estruturarDados(paginas, tipo) {
    if (tipo === 'ponto') {
        const resultado = { pages: [] };

        // 1. FINGERPRINTING: Descobre se o PDF tem a coluna "Jornada"
        let possuiColunaJornada = false;
        paginas.forEach(p => {
            const linhas = p.linhas || [];
            linhas.forEach(l => {
                const txt = l.toLowerCase();
                if (txt.includes('jornada') && txt.includes('entrada')) {
                    possuiColunaJornada = true;
                }
            });
        });

        paginas.forEach(pagina => {
            const pageObj = { page: pagina.page, days: [] };
            const linhas = pagina.linhas || [];

            let ultimoDiaEncontrado = null; 

            linhas.forEach(linha => {
                const linhaTrim = linha.trim();

                // Ignora falsos dias que são cabeçalhos de "Mês/Ano"
                if (/^\s*\d{1,2}\s*[\/\-\.]\s*\d{2,4}\s*$/.test(linhaTrim)) {
                    const partes = linhaTrim.split(/[\/\-\.]/).map(p => p.trim());
                    const n1 = parseInt(partes[0], 10);
                    const n2 = parseInt(partes[1], 10);
                    if (n1 >= 1 && n1 <= 12 && (n2 > 12 || partes[1].length === 4)) {
                        return; 
                    }
                }

                // 2. EXTRAÇÃO DE DATA BLINDADA (AQUI ESTAVA O SEGREDO)
                let date_raw = null;
                
                // Formato 1: Dia + Semana (O mais comum: "01 SAB", "12 - SEG") - Só aceita de 1 a 31
                const matchWk = linha.match(/\b(0?[1-9]|[12][0-9]|3[01])\s*[-–]?\s*(DOM|SEG|TER|QUA|QUI|SEX|SAB|DOMINGO|SEGUNDA|TERCA|TERÇA|QUARTA|QUINTA|SEXTA|SABADO|SÁBADO)\b/i);
                
                // Formato 2: Data Completa (DD/MM/YYYY)
                const matchFull = linha.match(/\b(0?[1-9]|[12][0-9]|3[01])[\/\-\.](0?[1-9]|1[0-2])[\/\-\.](\d{2,4})\b/i);
                
                // Formato 3: DD/MM Estrito (SÓ com barra, proíbe traços para não roubar horários como "00-10")
                const matchShort = linha.match(/\b(0?[1-9]|[12][0-9]|3[01])\/(0?[1-9]|1[0-2])\b(?!\d)/i);

                if (matchWk) {
                    date_raw = matchWk[0]; 
                } else if (matchFull) {
                    date_raw = matchFull[0];
                } else if (matchShort) {
                    date_raw = matchShort[0];
                }

                // Remove a data da linha SEM DESTRUIR AS HORAS
                let linhaParaHoras = linha;
                if (date_raw) {
                    linhaParaHoras = linhaParaHoras.replace(date_raw, '');
                }

                if (linhaParaHoras.includes('6b8cdfa') || linhaParaHoras.toLowerCase().includes('assinado')) {
                    return; 
                }

                // Corta lixos textuais
                const stringSomenteHorarios = linhaParaHoras.split(/[a-zA-Z]{3,}/)[0];
                const stringLimpa = stringSomenteHorarios.replace(/-/g, ' ');

                // 3. CAPTURA DE HORAS (Sobrevive a OCR lixo)
                const regexHoras = /\b([0-2][0-9])([0-5][0-9])\b|\b([0-2]?[0-9])[:;.,]+([0-5][0-9])\b/g;
                let horasMatch = [];
                let match;
                
                while ((match = regexHoras.exec(stringLimpa)) !== null) {
                    let h = match[1] || match[3];
                    let m = match[2] || match[4];
                    if (h.length === 1) h = '0' + h; 
                    horasMatch.push({
                        kind: "",
                        time_raw: match[0],
                        time_hhmm: `${h}:${m}`
                    });
                }

                let punchesAtuais = horasMatch;

                if (possuiColunaJornada && date_raw && punchesAtuais.length > 0) {
                    punchesAtuais = punchesAtuais.slice(1);
                }

                // Conserta a ordem maluca que o Tesseract cospe as colunas
                punchesAtuais.sort((a, b) => a.time_hhmm.localeCompare(b.time_hhmm));

                // 4. VÍNCULO DE DIAS E BATIDAS
                if (date_raw) {
                    ultimoDiaEncontrado = {
                        date_raw: date_raw.trim(),
                        punches: punchesAtuais
                    };
                    pageObj.days.push(ultimoDiaEncontrado);
                } 
                else if (punchesAtuais.length > 0 && ultimoDiaEncontrado) {
                    ultimoDiaEncontrado.punches.push(...punchesAtuais);
                    ultimoDiaEncontrado.punches.sort((a, b) => a.time_hhmm.localeCompare(b.time_hhmm));
                }

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