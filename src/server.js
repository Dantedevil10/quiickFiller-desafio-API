// src/server.js

import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { pdfQueue } from './queue.js';
import ExcelJS from 'exceljs';

import path from 'path';

const app = express();
app.use(cors());
app.use(express.json());

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname)); // Salva com .pdf no final!
    }
});

const upload = multer({ storage: storage });

// Configura o Multer para salvar o PDF temporariamente na pasta 'uploads/'
//const upload = multer({ dest: 'uploads/' });

// Rota 1: Recebe o PDF e coloca na fila
app.post('/api/upload', upload.single('documento'), async (req, res) => {
    if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado.' });

    const tipoDoc = req.body.tipo; // 'ponto' ou 'holerite' vindos do Angular
    const filePath = req.file.path;

    // Adiciona o trabalho na fila do BullMQ
    const job = await pdfQueue.add('extrair-dados', {
        filePath: filePath,
        tipo: tipoDoc,
        originalName: req.file.originalname
    });

    // O pulo do gato: responde IMEDIATAMENTE com o ID da tarefa, sem travar o request
    res.json({ 
        mensagem: 'Arquivo na fila de processamento', 
        jobId: job.id 
    });
});

// Rota 2: O Angular fica chamando essa rota para saber se já terminou
app.get('/api/status/:jobId', async (req, res) => {
    const job = await pdfQueue.getJob(req.params.jobId);
    
    if (!job) return res.status(404).json({ erro: 'Job não encontrado' });

    const state = await job.getState();
    
    // AQUI ESTÁ A MÁGICA: Se o job falhou, devolvemos o motivo do erro para o front!
    if (state === 'failed') {
        return res.json({ state: 'failed', erro: job.failedReason });
    }

    const result = job.returnvalue; // Aqui estará o JSON extraído quando terminar

    res.json({ state, result });
});

// NOVA ROTA: Recebe o JSON complexo e exporta para XLSX, CSV ou JSON
app.post('/api/exportar', async (req, res) => {
    const { dados: dadosEditados, tipo, formato = 'xlsx' } = req.body;

    if (!dadosEditados || !dadosEditados.pages) {
        return res.status(400).json({ erro: 'Dados inválidos enviados.' });
    }

    try {
        // ========================================================
        // EXPORTAÇÃO DIRETA EM JSON
        // ========================================================
        if (formato === 'json') {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', `attachment; filename=extracao_${tipo}_${Date.now()}.json`);
            return res.send(JSON.stringify(dadosEditados, null, 2));
        }

        // ========================================================
        // LÓGICA DE PLANILHAS (XLSX E CSV)
        // ========================================================
        const workbook = new ExcelJS.Workbook();

        const styleHeader = (row) => {
            row.eachCell({ includeEmpty: true }, cell => {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF173772' } };
                cell.font = { color: { argb: 'FFFFFFFF' }, bold: true };
                cell.alignment = { vertical: 'middle', horizontal: 'center' };
            });
        };

        const applyRowStyle = (row, bgColorHex, applyLeftBorder) => {
            row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColorHex } };
                if (applyLeftBorder && colNumber === 1) {
                    cell.border = { left: { style: 'thick', color: { argb: 'FFDC3545' } } };
                }
            });
        };

        if (tipo === 'ponto') {
            const worksheet = workbook.addWorksheet('Cartão de Ponto');

            let maxPunches = 0;
            dadosEditados.pages.forEach(p => p.days?.forEach(d => {
                if (d.punches?.length > maxPunches) maxPunches = d.punches.length;
            }));

            if (maxPunches < 4) maxPunches = 4;

            const columns = [{ header: 'Data', key: 'data', width: 18 }];
            for (let i = 0; i < maxPunches; i++) {
                const tipoBatida = i % 2 === 0 ? 'Entrada' : 'Saída';
                const numeroVez = Math.floor(i / 2) + 1;
                columns.push({ header: `${tipoBatida} ${numeroVez}`, key: `p${i}`, width: 12 });
            }
            worksheet.columns = columns;
            styleHeader(worksheet.getRow(1));

            let prevDayNum = null;

            dadosEditados.pages.forEach(p => {
                p.days?.forEach(d => {
                    let hasQuestionMark = (d.date_raw || '').includes('?');
                    let rowData = { data: d.date_raw || '-' };
                    let punches = d.punches || [];

                    punches.forEach((punch, index) => {
                        rowData[`p${index}`] = punch.time_hhmm;
                        if (punch.time_hhmm.includes('?')) hasQuestionMark = true;
                    });

                    const row = worksheet.addRow(rowData);

                    const isOdd = punches.length % 2 !== 0;
                    const isEmpty = punches.length === 0;
                    
                    let isNonSeq = false;
                    const currDayMatch = d.date_raw.match(/^\s*(\d{1,2})\b/);
                    if (currDayMatch) {
                        const currDayNum = parseInt(currDayMatch[1], 10);
                        if (prevDayNum !== null) {
                            if (currDayNum !== prevDayNum + 1 && !(prevDayNum >= 28 && currDayNum === 1)) {
                                isNonSeq = true;
                            }
                        }
                        prevDayNum = currDayNum;
                    }

                    if (isNonSeq) applyRowStyle(row, 'FFF8D7DA', true);
                    else if (isOdd || isEmpty || hasQuestionMark) applyRowStyle(row, 'FFFFF3CD', false);
                    
                    row.eachCell((cell, colNumber) => { if(colNumber > 1) cell.alignment = { horizontal: 'center' }; });
                });
            });
        } 
        else if (tipo === 'holerite') {
            const worksheet = workbook.addWorksheet('Holerites');

            const colunasVerbas = new Set();
            dadosEditados.pages.forEach(p => {
                p.fields?.forEach(f => colunasVerbas.add(f.label));
                p.bases?.forEach(b => colunasVerbas.add(b.label));
            });

            const columns = [
                { header: 'Pág.', key: 'page', width: 8 },
                { header: 'Mês', key: 'month', width: 8 },
                { header: 'Ano', key: 'year', width: 8 }
            ];
            colunasVerbas.forEach(verba => columns.push({ header: verba, key: verba, width: 18 }));
            worksheet.columns = columns;
            styleHeader(worksheet.getRow(1));

            let prevMonthNum = null;

            dadosEditados.pages.forEach(p => {
                let hasQuestionMark = (p.month || '').includes('?') || (p.year || '').includes('?');
                let rowData = { page: p.page, month: p.month, year: p.year };
                let fieldsCount = 0;

                p.fields?.forEach(f => {
                    rowData[f.label] = f.value;
                    if ((f.value || '').includes('?')) hasQuestionMark = true;
                    fieldsCount++;
                });
                p.bases?.forEach(b => {
                    rowData[b.label] = b.value;
                    if ((b.value || '').includes('?')) hasQuestionMark = true;
                    fieldsCount++;
                });

                const row = worksheet.addRow(rowData);

                const isEmpty = fieldsCount === 0;

                let isNonSeq = false;
                const currMonthNum = parseInt(p.month, 10);
                if (!isNaN(currMonthNum)) {
                    if (prevMonthNum !== null) {
                        if (currMonthNum !== prevMonthNum + 1 && !(prevMonthNum === 12 && currMonthNum === 1)) {
                            isNonSeq = true;
                        }
                    }
                    prevMonthNum = currMonthNum;
                }

                if (isNonSeq) applyRowStyle(row, 'FFF8D7DA', true);
                else if (isEmpty || hasQuestionMark) applyRowStyle(row, 'FFFFF3CD', false);
            });
        }

        // ========================================================
        // RETORNO DO ARQUIVO PARA DOWNLOAD (XLSX ou CSV)
        // ========================================================
        const filenameTag = `extracao_${tipo}_${Date.now()}`;

        if (formato === 'csv') {
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=${filenameTag}.csv`);
            await workbook.csv.write(res);
        } else {
            // Default: xlsx
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename=${filenameTag}.xlsx`);
            await workbook.xlsx.write(res);
        }
        res.end();

    } catch (error) {
        console.error(`Erro ao exportar ${formato}:`, error);
        res.status(500).json({ erro: 'Falha ao exportar os dados.' });
    }
});

app.listen(3000, () => console.log('🚀 Servidor rodando na porta 3000'));