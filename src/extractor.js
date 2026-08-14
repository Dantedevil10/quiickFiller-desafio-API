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

    // 1. Tenta extração vetorial...
    try {
        const data = await pdfExtract.extract(validPath, {});
        let paginas = [];
        
        (data.pages || []).forEach((page, index) => {
            let items = page.content || [];
            if (items.length === 0) return;

            items.sort((a, b) => {
                if (Math.abs(a.y - b.y) < 8) return a.x - b.x; 
                return a.y - b.y;
            });

            let linhas = [];
            let currentLineStr = "";
            let currentY = items[0]?.y || 0;
            let lastX = 0;
            let lastWidth = 0;

            items.forEach(item => {
                if (!item.str || item.str.trim() === '') return;

                if (Math.abs(item.y - currentY) > 8) { 
                    if (currentLineStr.trim().length > 0) linhas.push(currentLineStr.trim());
                    currentLineStr = item.str;
                    currentY = item.y;
                    lastX = item.x;
                    lastWidth = item.width || 0;
                } else {
                    let gap = item.x - (lastX + lastWidth);
                    if (gap > 12) currentLineStr += "    " + item.str; 
                    else if (gap > 2) currentLineStr += " " + item.str;    
                    else currentLineStr += item.str;        
                    
                    lastX = item.x;
                    lastWidth = item.width || 0;
                }
            });
            if (currentLineStr.trim().length > 0) linhas.push(currentLineStr.trim());

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

    // 2. OCR Usando pdf-to-img + Tesseract
    console.log('⚠️ Executando OCR via pdf-to-img + Tesseract...');
    try {
        const document = await pdf(validPath, { scale: 2 });
        let paginasOCR = [];
        let pageCounter = 1;

        for await (const imageBuffer of document) {
            const { data: { text } } = await tesseract.recognize(imageBuffer, 'por');
            const linhasOCR = text.split('\n').filter(linha => linha.trim() !== '');
            
            console.log(`\n================== [INÍCIO OCR PÁGINA ${pageCounter}] ==================`);
            console.log(text);
            console.log(`================== [FIM OCR PÁGINA ${pageCounter}] ==================\n`);

            paginasOCR.push({ page: pageCounter++, linhas: linhasOCR });
        }

        // =========================================================
        // 🚨 VALIDAÇÃO DE QUALIDADE DO OCR (A TRAVA DE LIXO) 🚨
        // =========================================================
        const textoTotal = paginasOCR.map(p => p.linhas.join(' ')).join(' ').toLowerCase();
        
        // Conta horários em formato minimamente aceitável (ex: 08:30, 14:00)
        const horáriosEncontrados = (textoTotal.match(/\b[0-2]?[0-9]:[0-5][0-9]\b/g) || []).length;
        
        // Conta palavras essenciais que todo holerite ou ponto deve ter (mesmo que com pequenos erros)
        const palavrasChave = ['entrada', 'saida', 'saída', 'quinzena', 'jornada', 'ponto', 'horas', 'extra', 'total', 'rep', 'semanal'];
        const qtdPalavrasEncontradas = palavrasChave.filter(palavra => textoTotal.includes(palavra)).length;

        console.log(`📊 [Qualidade OCR] Horários: ${horáriosEncontrados} | Palavras-chave: ${qtdPalavrasEncontradas}`);

        // REGRA DE REJEIÇÃO: Se o Tesseract vomitou lixo, ele não acha horários formatados direito nem palavras legíveis.
        // Se achou menos de 2 palavras-chave E menos de 5 horários limpos no documento INTEIRO:
        if (qtdPalavrasEncontradas < 2 && horáriosEncontrados < 5) {
            const erroIlegivel = new Error("O arquivo não pôde ser lido com clareza. A imagem está ilegível ou muito bagunçada.");
            erroIlegivel.code = "OCR_ILEGIVEL"; // Passa um código para o backend saber exatamente qual foi o erro
            throw erroIlegivel;
        }
        // =========================================================

        if (validPath !== filePath && fs.existsSync(validPath)) fs.unlinkSync(validPath);
        return paginasOCR;
    } catch (ocrError) {
        if (validPath !== filePath && fs.existsSync(validPath)) fs.unlinkSync(validPath);
        throw ocrError; // Repassa o erro de leitura estourado para o Job/Controller
    }
}

// ==========================================
// FUNÇÃO 1: CARTÃO DE PONTO (MANTIDA INTACTA)
// ==========================================
function estruturarCartaoPonto(paginas) {
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

            if (
                lower.includes('cartão de ponto') || lower.includes('emissão:') || lower.includes('seção:') ||
                lower.includes('período:') || lower.includes('chapa') || lower.includes('carteira de trabalho') ||
                lower.includes('função') || lower.includes('cargo') || lower.includes('quantidade de horas') ||
                lower.includes('ent') || lower.includes('sai') || lower.includes('h.ext') ||
                lower.includes('atraso') || lower.includes('falta') || lower.includes('ad.not') ||
                lower.includes('abono jornada') || lower.includes('total de horas') || lower.includes('folgas geradas') ||
                lower.includes('código nome jornada') || lower.includes('impresso por') ||
                lower.includes('pje documento assinado') || lower.includes('(*) horas não trabalhadas') ||
                /^\s*[-–]\s*operador/.test(lower) || /^\s*\d{1,2}\s*[\/\-\.]\s*\d{2,4}\s*$/.test(linhaTrim)
            ) {
                return;
            }

            let zonaDados = linhaTrim;
            if (linhaTrim.includes('|')) {
                zonaDados = linhaTrim.split('|')[0];
            }

            let date_raw = null;
            const regexSemana = /(?:\s*[-–|]?\s*(?:DOM|SEG|TER|QUA|QUI|SEX|SAB|DOMINGO|SEGUNDA|TERCA|TERÇA|QUARTA|QUINTA|SEXTA|SABADO|SÁBADO))?/i;

            const matchFull = zonaDados.match(new RegExp(`\\b(0?[1-9]|[12][0-9]|3[01])[\\/\\-\\.](0?[1-9]|1[0-2])[\\/\\-\\.](\\d{4})` + regexSemana.source + `\\b`, 'i'));
            const matchWk = zonaDados.match(/\b(0?[1-9]|[12][0-9]|3[01])\s*[-–|]?\s*(DOM|SEG|TER|QUA|QUI|SEX|SAB|DOMINGO|SEGUNDA|TERCA|TERÇA|QUARTA|QUINTA|SEXTA|SABADO|SÁBADO)\b/i);
            const matchShort = zonaDados.match(new RegExp(`\\b(0?[1-9]|[12][0-9]|3[01])\\/(0?[1-9]|1[0-2])\\b(?!\\d)` + regexSemana.source, 'i'));

            if (matchFull) date_raw = matchFull[0];
            else if (matchWk) date_raw = matchWk[0]; 
            else if (matchShort) date_raw = matchShort[0];

            let zonaHorarios = zonaDados;
            if (date_raw) zonaHorarios = zonaHorarios.replace(date_raw, '');

            let horasMatch = [];
            if (!lower.includes('feriado') && !lower.includes('descanso semanal') && !lower.includes('sem registro de ponto') &&
                !lower.includes('natal') && !lower.includes('confraternização') && !lower.includes('abono')) {
                const regexHoras = /\b\+?([0-2][0-9])\s*[:;.,]?\s*([0-5][0-9])(?![0-9])/g;
                let match;
                while ((match = regexHoras.exec(zonaHorarios)) !== null) {
                    let h = match[1];
                    let m = match[2];
                    const horaNum = parseInt(h, 10);
                    const minutoNum = parseInt(m, 10);
                    if (horaNum >= 0 && horaNum <= 23 && minutoNum >= 0 && minutoNum <= 59) {
                        horasMatch.push({ kind: "", time_raw: match[0], time_hhmm: `${h}:${m}` });
                    }
                }
            }

            let punchesAtuais = horasMatch.slice(0, 4);
            if (possuiColunaJornada && date_raw && punchesAtuais.length > 0) punchesAtuais = punchesAtuais.slice(1);
            punchesAtuais.sort((a, b) => a.time_hhmm.localeCompare(b.time_hhmm));

            if (date_raw) {
                ultimoDiaEncontrado = { date_raw: date_raw.trim(), punches: punchesAtuais };
                pageObj.days.push(ultimoDiaEncontrado);
            } else if (punchesAtuais.length > 0) {
                if (ultimoDiaEncontrado) {
                    ultimoDiaEncontrado.punches.push(...punchesAtuais);
                    ultimoDiaEncontrado.punches.sort((a, b) => a.time_hhmm.localeCompare(b.time_hhmm));
                    ultimoDiaEncontrado.punches = ultimoDiaEncontrado.punches.slice(0, 4);
                } else {
                    ultimoDiaEncontrado = { date_raw: "DESCONHECIDO", punches: punchesAtuais };
                    pageObj.days.push(ultimoDiaEncontrado);
                }
            }

            if (ultimoDiaEncontrado && ultimoDiaEncontrado.punches.length > 0) {
                ultimoDiaEncontrado.punches.forEach((p, index) => p.kind = index % 2 === 0 ? "IN" : "OUT");
            }
        });

        resultado.pages.push(pageObj);
    });

    return resultado;
}

// ==========================================
// FUNÇÃO 2.1: HOLERITE PADRÃO E PJe (Restaurada e Blindada)
// ==========================================
function parseHoleriteNormal(paginas) {
    const resultado = { pages: [] };

    // Função interna para bloquear rótulos inválidos de entrarem como verba
    function isInvalid(lbl, cod) {
        const l = lbl.toUpperCase().replace(/\s/g, '');
        const c = cod.toUpperCase();
        if (c === 'TOT' || c.includes('TOTAL') || c === 'BASE' || c === 'SAL' || c.includes('LIQ')) return true;
        if (l.startsWith('TOTAL') || l.includes('LÍQÜIDO') || l.includes('LIQUIDO')) return true;
        if (l.startsWith('BASE') || l.includes('FGTS')) return true;
        return false;
    }

    paginas.forEach(pagina => {
        const linhasBrutas = pagina.linhas || [];
        let currentMonth = "01";
        let currentYear = "2020";

        // Captura Mês/Ano
        linhasBrutas.forEach(linha => {
            const linhaLimpa = linha.replace(/\s/g, '');
            const matchPeriodo = linhaLimpa.match(/Período[:]?(\d{2})\/(\d{4})/i);
            if (matchPeriodo) {
                currentMonth = matchPeriodo[1];
                currentYear = matchPeriodo[2];
            } else {
                const matchMesAno = linha.match(/Mês\/Ano:\s*(0?[1-9]|1[0-2])\/(\d{2,4})/i);
                if (matchMesAno) {
                    currentMonth = matchMesAno[1].padStart(2, '0');
                    const anoStr = matchMesAno[2];
                    currentYear = anoStr.length === 2 ? "20" + anoStr : anoStr;
                }
            }
        });

        const pageObj = {
            page: pagina.page,
            year: currentYear,
            month: currentMonth,
            fields: [],
            bases: []
        };

        let capturandoVerbas = false;

        linhasBrutas.forEach(linha => {
            const linhaLimpaGeral = linha.replace(/\s/g, '');
            const upperGeral = linhaLimpaGeral.toUpperCase();

            // Gatilho de início das verbas
            if (upperGeral.includes('COD.DESCRIÇÃO') || upperGeral.includes('VERBANOME') || upperGeral.includes('CÓD.DESCRIÇÃO')) {
                capturandoVerbas = true;
                return;
            }

            // Gatilho de fim das verbas
            if (upperGeral.startsWith('TOTAL') || upperGeral.startsWith('LÍQÜIDO') || upperGeral.startsWith('LIQUIDO') || upperGeral.startsWith('BASE')) {
                capturandoVerbas = false;
            }

            // Captura Bases e Totais independentemente da linha de verbas
            if (upperGeral.includes('BASEI.N.S.S.')) {
                const m = linhaLimpaGeral.match(/BaseI\.N\.S\.S\.[:]*([\d\.,]+)/i);
                if (m) pageObj.bases.push({ label: "Base INSS", value: m[1] });
            }
            if (upperGeral.includes('BASEI.R.R.F.')) {
                const m = linhaLimpaGeral.match(/BaseI\.R\.R\.F\.[:]*([\d\.,]+)/i);
                if (m) pageObj.bases.push({ label: "Base IRRF", value: m[1] });
            }
            if (upperGeral.includes('BASEFGTS')) {
                const m = linhaLimpaGeral.match(/BaseFGTS[:]*([\d\.,]+)/i);
                if (m) pageObj.bases.push({ label: "Base FGTS", value: m[1] });
            }
            if (upperGeral.includes('F.G.T.S.DOMÊS') || upperGeral.includes('FGTSDOMES') || upperGeral.includes('F.G.T.S.DOMES')) {
                const m = linhaLimpaGeral.match(/F\.G\.T\.S\.DOM[ÊE]S[:]*([\d\.,]+)/i) || linhaLimpaGeral.match(/FGTSDOM[ÊE]S[:]*([\d\.,]+)/i);
                if (m) pageObj.bases.push({ label: "FGTS do Mês", value: m[1] });
            }

            if (!capturandoVerbas) return;

            let textLeft = linha.trim();

            // Pula a linha do cabeçalho da tabela se ela escorregar pro bloco de verbas
            if (textLeft.toUpperCase().includes('DESCRIÇÃO') && textLeft.toUpperCase().includes('PROVENTOS')) return;

            // Tenta achar 4 colunas (Código + Descrição + Ref + Valor)
            // Agora o regex suporta códigos com letras/barras e descrições com % e ()
            const regex4Col = /(?:^|\s)([\/A-Za-z0-9]{1,5})\s+([A-Za-zÀ-ÿ0-9\.\º\ª\s\-\/\%\(\)\+]+?)\s+([-\d\.,]+)\s+([-\d\.,]{3,})(?=\s|$)/g;
            let achou = false;
            let match;
            while ((match = regex4Col.exec(textLeft)) !== null) {
                const code = match[1].trim();
                const label = match[2].trim();
                if (!isInvalid(label, code)) {
                    pageObj.fields.push({ code, label, reference: match[3], value: match[4] });
                    achou = true;
                }
                textLeft = textLeft.replace(match[0], ' '); // Remove a verba capturada da linha
            }

            // Se não achou 4 colunas, tenta encontrar o formato de 3 colunas (Código + Descrição + Valor)
            if (!achou) {
                const regex3Col = /(?:^|\s)([\/A-Za-z0-9]{1,5})\s+([A-Za-zÀ-ÿ0-9\.\º\ª\s\-\/\%\(\)\+]+?)\s+([-\d\.,]{3,})(?=\s|$)/g;
                while ((match = regex3Col.exec(textLeft)) !== null) {
                    const code = match[1].trim();
                    const label = match[2].trim();
                    if (!isInvalid(label, code)) {
                        pageObj.fields.push({ code, label, reference: "", value: match[3] });
                    }
                    textLeft = textLeft.replace(match[0], ' ');
                }
            }
        });

        if (pageObj.fields.length > 0 || pageObj.bases.length > 0) {
            resultado.pages.push(pageObj);
        }
    });

    return resultado;
}

// ==========================================
// FUNÇÃO 2.2: FICHA FINANCEIRA (Multi-colunas / Multi-meses)
// ==========================================
function parseFichaFinanceira(paginas) {
    const resultado = { pages: [] };
    let currentMonthObj = null;

    paginas.forEach(pagina => {
        const linhas = pagina.linhas || [];

        linhas.forEach(linha => {
            const linhaUpper = linha.toUpperCase();

            // 1. Ignora linhas que geram lixo estrutural
            if (linhaUpper.includes('ASSINADO ELETRONICAMENTE') || linhaUpper.includes('DE JUNHO DE') || linhaUpper.includes('FLS.:')) {
                return;
            }

            // 2. Detecta quando o bloco de um mês começa (Ex: "Mês: abr-17")
            const matchMes = linhaUpper.match(/M[ÊE]S:\s*([A-Z]{3})[-/](\d{2,4})/);
            if (matchMes) {
                // Salva o mês anterior antes de criar o novo
                if (currentMonthObj && (currentMonthObj.fields.length > 0 || currentMonthObj.bases.length > 0)) {
                    resultado.pages.push(currentMonthObj);
                }

                const mesStr = matchMes[1].toLowerCase();
                const anoRaw = matchMes[2];
                const y = anoRaw.length === 2 ? "20" + anoRaw : anoRaw;
                const mesesMap = { jan: "01", fev: "02", mar: "03", abr: "04", mai: "05", jun: "06", jul: "07", ago: "08", set: "09", out: "10", nov: "11", dez: "12" };
                const m = mesesMap[mesStr] || "01";

                currentMonthObj = {
                    page: pagina.page,
                    year: y,
                    month: m,
                    fields: [],
                    bases: []
                };
                return;
            }

            if (!currentMonthObj) return;

            let textoParaVerbas = linha;

            // 3. Captura Bases e Totais da Ficha (e limpa da string para não confundir com as verbas)
            const basesParaExtrair = [
                { regex: /BASEDECALCULODOINSS\s*([\d\.,]+)/i, label: "Base INSS" },
                { regex: /BASEDECALCULODOIRF\s*([\d\.,]+)/i, label: "Base IRRF" },
                { regex: /BASEDECALCULODOFGTS\s*([\d\.,]+)/i, label: "Base FGTS" },
                { regex: /VALORDOFGTS\s*([\d\.,]+)/i, label: "FGTS do Mês" },
                { regex: /SALARIOLIQUIDONOMES\s*([\d\.,]+)/i, label: "Valor Líquido" },
                { regex: /TOT\.RENDIMENTOS\s*([\d\.,]+)/i, label: "Total Vencimentos" },
                { regex: /TOTALDESCONTOS\s*([\d\.,]+)/i, label: "Total Descontos" }
            ];

            basesParaExtrair.forEach(base => {
                const m = textoParaVerbas.match(base.regex);
                if (m) {
                    currentMonthObj.bases.push({ label: base.label, value: m[1] });
                    textoParaVerbas = textoParaVerbas.replace(m[0], ' '); 
                }
            });

            // Limpa informações que parecem verbas numéricas mas não são
            textoParaVerbas = textoParaVerbas.replace(/VALORDOIRFARECOLHER\s*[\d\.,]+/gi, ' ');
            textoParaVerbas = textoParaVerbas.replace(/REMUNERAÇÃOMES\s*[\d\.,]+/gi, ' ');
            textoParaVerbas = textoParaVerbas.replace(/DIAS\/HORASTRAB\s*[\d\.,]+/gi, ' ');

            // 4. Captura as Verbas agrupadas lado a lado (Código + Descrição + Referencia + Valor)
            const regexVerbas = /(?:^|\s)(\d{1,4}|\/[A-Z0-9]{1,3})\s+([A-Za-zÀ-ÿ0-9\.\º\ª\s\-\/\%]+?)\s+([-\d\.,]+)\s+([-\d\.,]{3,})\b/g;
            let matchV;
            while ((matchV = regexVerbas.exec(textoParaVerbas)) !== null) {
                const code = matchV[1].trim();
                const label = matchV[2].trim();
                const val1 = matchV[3];
                const val2 = matchV[4];

                if (label.length > 2 && !label.toUpperCase().includes('BASE')) {
                    currentMonthObj.fields.push({
                        code: code,
                        label: label,
                        reference: val1,
                        value: val2
                    });
                }
            }
        });
    });

    // Empurra o último bloco da Ficha Financeira capturado
    if (currentMonthObj && (currentMonthObj.fields.length > 0 || currentMonthObj.bases.length > 0)) {
        resultado.pages.push(currentMonthObj);
    }

    return resultado;
}

// ==========================================
// FUNÇÃO 2.0: ROTEADOR PRINCIPAL DO HOLERITE
// ==========================================
function estruturarHolerite(paginas) {
    let isFichaFinanceira = false;

    // Checagem prévia rápida do layout do PDF
    for (let p of paginas) {
        const linhas = p.linhas || [];
        for (let l of linhas) {
            const upper = l.toUpperCase().replace(/\s/g, '');
            // Se encontrar a estrutura de Ficha Financeira, aciona o trigger
            if (upper.includes('FICHAFINANCEIRA') || upper.includes('RENDIMENTOSDESCONTOSRESULTADOS')) {
                isFichaFinanceira = true;
                break;
            }
        }
        if (isFichaFinanceira) break;
    }

    if (isFichaFinanceira) {
        console.log("➡️ Tipo detectado: FICHA FINANCEIRA (Multi-colunas). Roteando para parser especializado...");
        return parseFichaFinanceira(paginas);
    } else {
        console.log("➡️ Tipo detectado: HOLERITE PADRÃO/PJE. Roteando para parser de página única...");
        return parseHoleriteNormal(paginas);
    }
}

// ==========================================
// FUNÇÃO PRINCIPAL DE ROTEAMENTO
// ==========================================
export function estruturarDados(paginas, tipo) {
    if (tipo === 'ponto') {
        return estruturarCartaoPonto(paginas);
    }
    
    if (tipo === 'holerite') {
        return estruturarHolerite(paginas);
    }

    return { pages: [] };
}