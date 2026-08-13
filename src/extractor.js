// src/extractor.js

import { PDFExtract } from 'pdf.js-extract';
import tesseract from 'tesseract.js';
import { pdf } from 'pdf-to-img';
import fs from 'fs';

const pdfExtract = new PDFExtract();

export async function extrairTextoPDF(filePath) {
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

    // 2. OCR Usando pdf-to-img + Tesseract com LOG em tempo real
    console.log('⚠️ Executando OCR via pdf-to-img + Tesseract...');
    try {
        const document = await pdf(validPath, { scale: 2 });
        let paginasOCR = [];
        let pageCounter = 1;

        for await (const imageBuffer of document) {
            const { data: { text } } = await tesseract.recognize(imageBuffer, 'por');
            
            // --- LOG PARA INSPECIONAR O QUE O TESSERACT PUXOU ---
            console.log(`\n================== [INÍCIO OCR PÁGINA ${pageCounter}] ==================`);
            console.log(text);
            console.log(`================== [FIM OCR PÁGINA ${pageCounter}] ==================\n`);
            // ----------------------------------------------------

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
                const lower = linhaTrim.toLowerCase();

                // 1. IGNORA LINHAS DE CABEÇALHO E METADADOS DO DOCUMENTO
                if (
                    lower.includes('cartão de ponto') ||
                    lower.includes('emissão:') ||
                    lower.includes('seção:') ||
                    lower.includes('período:') ||
                    lower.includes('chapa') ||
                    lower.includes('carteira de trabalho') ||
                    lower.includes('função') ||
                    lower.includes('cargo') ||
                    lower.includes('quantidade de horas') ||
                    lower.includes('ent') ||
                    lower.includes('sai') ||
                    lower.includes('h.ext') ||
                    lower.includes('atraso') ||
                    lower.includes('falta') ||
                    lower.includes('ad.not') ||
                    lower.includes('abono jornada') ||
                    lower.includes('total de horas') ||
                    lower.includes('folgas geradas') ||
                    lower.includes('código nome jornada') ||
                    lower.includes('impresso por') ||
                    lower.includes('pje documento assinado') ||
                    lower.includes('(*) horas não trabalhadas') ||
                    /^\s*[-–]\s*operador/.test(lower)
                ) {
                    return;
                }

                if (/^\s*\d{1,2}\s*[\/\-\.]\s*\d{2,4}\s*$/.test(linhaTrim)) {
                    return;
                }

                // 2. TRATAMENTO INTELIGENTE DE SEPARADOR
                let zonaDados = linhaTrim;
                if (linhaTrim.includes('|')) {
                    zonaDados = linhaTrim.split('|')[0];
                }

                // 3. EXTRAÇÃO DE DATA BLINDADA
                let date_raw = null;
                const regexSemana = /(?:\s*[-–|]?\s*(?:DOM|SEG|TER|QUA|QUI|SEX|SAB|DOMINGO|SEGUNDA|TERCA|TERÇA|QUARTA|QUINTA|SEXTA|SABADO|SÁBADO))?/i;

                const matchFull = zonaDados.match(new RegExp(`\\b(0?[1-9]|[12][0-9]|3[01])[\\/\\-\\.](0?[1-9]|1[0-2])[\\/\\-\\.](\\d{4})` + regexSemana.source + `\\b`, 'i'));
                const matchWk = zonaDados.match(/\b(0?[1-9]|[12][0-9]|3[01])\s*[-–|]?\s*(DOM|SEG|TER|QUA|QUI|SEX|SAB|DOMINGO|SEGUNDA|TERCA|TERÇA|QUARTA|QUINTA|SEXTA|SABADO|SÁBADO)\b/i);
                const matchShort = zonaDados.match(new RegExp(`\\b(0?[1-9]|[12][0-9]|3[01])\\/(0?[1-9]|1[0-2])\\b(?!\\d)` + regexSemana.source, 'i'));

                if (matchFull) {
                    date_raw = matchFull[0];
                } else if (matchWk) {
                    date_raw = matchWk[0]; 
                } else if (matchShort) {
                    date_raw = matchShort[0];
                }

                let zonaHorarios = zonaDados;
                if (date_raw) {
                    zonaHorarios = zonaHorarios.replace(date_raw, '');
                }

                // Se o dia for feriado, descanso ou sem registro, zera os horários para evitar falsos positivos
                let horasMatch = [];
                if (
                    !lower.includes('feriado') &&
                    !lower.includes('descanso semanal') &&
                    !lower.includes('sem registro de ponto') &&
                    !lower.includes('natal') &&
                    !lower.includes('confraternização') &&
                    !lower.includes('abono')
                ) {
                    // 4. CAPTURA DE HORAS ROBUSTA (Suporta HH:MM com ou sem dois pontos, ex: 1815 ou 12:00)
                    const regexHoras = /\b\+?([0-2][0-9])\s*[:;.,]?\s*([0-5][0-9])(?![0-9])/g;
                    let match;
                    
                    while ((match = regexHoras.exec(zonaHorarios)) !== null) {
                        let h = match[1];
                        let m = match[2];
                        
                        const horaNum = parseInt(h, 10);
                        const minutoNum = parseInt(m, 10);

                        if (horaNum >= 0 && horaNum <= 23 && minutoNum >= 0 && minutoNum <= 59) {
                            horasMatch.push({
                                kind: "",
                                time_raw: match[0],
                                time_hhmm: `${h}:${m}`
                            });
                        }
                    }
                }

                let punchesAtuais = horasMatch.slice(0, 4);

                if (possuiColunaJornada && date_raw && punchesAtuais.length > 0) {
                    punchesAtuais = punchesAtuais.slice(1);
                }

                punchesAtuais.sort((a, b) => a.time_hhmm.localeCompare(b.time_hhmm));

                // 5. VÍNCULO DE DIAS E BATIDAS
                if (date_raw) {
                    ultimoDiaEncontrado = {
                        date_raw: date_raw.trim(),
                        punches: punchesAtuais
                    };
                    pageObj.days.push(ultimoDiaEncontrado);
                } 
                else if (punchesAtuais.length > 0) {
                    if (ultimoDiaEncontrado) {
                        ultimoDiaEncontrado.punches.push(...punchesAtuais);
                        ultimoDiaEncontrado.punches.sort((a, b) => a.time_hhmm.localeCompare(b.time_hhmm));
                        ultimoDiaEncontrado.punches = ultimoDiaEncontrado.punches.slice(0, 4);
                    } else {
                        ultimoDiaEncontrado = {
                            date_raw: "DESCONHECIDO",
                            punches: punchesAtuais
                        };
                        pageObj.days.push(ultimoDiaEncontrado);
                    }
                }

                if (ultimoDiaEncontrado && ultimoDiaEncontrado.punches.length > 0) {
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