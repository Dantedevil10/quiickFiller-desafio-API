// src/server.js
import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { pdfQueue, redis } from './queue.js';
import ExcelJS from 'exceljs';
import path from 'path';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname));
    }
});
// Validação rígida exigida pela especificação
const upload = multer({ 
    storage: storage,
    limits: { 
        fileSize: 10 * 1024 * 1024 // Limite de 10MB
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Apenas arquivos PDF são permitidos.'));
        }
    }
});

// ==========================================
// ROTA 1: HEALTHCHECK (Exigência do contrato)
// ==========================================
app.get('/healthz', (req, res) => {
    res.status(200).send('OK');
});

// ==========================================
// ROTA 2: POST /api/transcricoes (Upload Literal)
// ==========================================
app.post('/api/transcricoes', upload.single('arquivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ erro: 'Campo "arquivo" é obrigatório.' });
    
    const tipo = req.body.tipo; // 'cartao-ponto' ou 'holerite'
    
    const job = await pdfQueue.add('extrair-dados', {
        filePath: req.file.path,
        tipo: tipo
    });

    // HTTP 202 Accepted + Retorno literal exigido
    res.status(202).json({ id: String(job.id) });
});

// ==========================================
// ROTA 3: GET /api/transcricoes/:id (Polling Status)
// ==========================================
app.get('/api/transcricoes/:id', async (req, res) => {
    const { id } = req.params;
    const job = await pdfQueue.getJob(id);
    
    if (!job) return res.status(404).json({ erro: 'Transcrição não encontrada.' });

    const state = await job.getState();

    if (state === 'failed') {
        return res.status(200).json({
            id: String(id),
            tipo: job.data.tipo,
            status: "erro",
            erro: job.failedReason || "Erro desconhecido",
            value: null
        });
    }

    if (state === 'completed') {
        // Busca do Redis os dados que o worker salvou
        const redisData = await redis.get(`transcricao:${id}`);
        if (redisData) {
            return res.status(200).json(JSON.parse(redisData));
        }
    }

    // Se estiver active ou waiting
    return res.status(200).json({
        id: String(id),
        tipo: job.data.tipo,
        status: "processando",
        erro: null,
        value: null,
        mensagemProgresso: job.progress || "Aguardando na fila do servidor..."
    });
});

// ==========================================
// ROTA 4: PUT /api/transcricoes/:id (Atualizar Edições)
// ==========================================
app.put('/api/transcricoes/:id', async (req, res) => {
    const { id } = req.params;
    const { value } = req.body;

    const redisData = await redis.get(`transcricao:${id}`);
    if (!redisData) return res.status(404).json({ erro: 'Transcrição não encontrada.' });

    const transcricao = JSON.parse(redisData);
    transcricao.value = value; // Substitui pelo value editado no front

    // Atualiza no Redis
    await redis.set(`transcricao:${id}`, JSON.stringify(transcricao), 'EX', 86400);

    res.status(200).json(transcricao);
});

// ==========================================
// ROTA 5: GET /api/transcricoes/:id/planilha (Download Condicional Avançado)
// ==========================================
app.get('/api/transcricoes/:id/planilha', async (req, res) => {
    const { id } = req.params;
    const formato = req.query.formato || 'xlsx';

    const redisData = await redis.get(`transcricao:${id}`);
    if (!redisData) return res.status(404).json({ erro: 'Transcrição não encontrada.' });

    const { tipo, value: dadosEditados } = JSON.parse(redisData);

    if (formato === 'json') {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename=extracao_${tipo}_${id}.json`);
        return res.send(JSON.stringify(dadosEditados, null, 2));
    }

    try {
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
                if (applyLeftBorder && colNumber === 1) cell.border = { left: { style: 'thick', color: { argb: 'FFDC3545' } } };
            });
        };

        if (tipo === 'cartao-ponto') {
            const worksheet = workbook.addWorksheet('Cartão de Ponto');
            let maxPunches = 0;
            dadosEditados.pages?.forEach(p => p.days?.forEach(d => {
                if (d.punches?.length > maxPunches) maxPunches = d.punches.length;
            }));
            if (maxPunches < 4) maxPunches = 4;

            const columns = [{ header: 'Data', key: 'data', width: 18 }];
            for (let i = 0; i < maxPunches; i++) {
                columns.push({ header: `${i % 2 === 0 ? 'Entrada' : 'Saída'} ${Math.floor(i / 2) + 1}`, key: `p${i}`, width: 12 });
            }
            worksheet.columns = columns;
            styleHeader(worksheet.getRow(1));

            let prevDayNum = null;

            dadosEditados.pages?.forEach(p => p.days?.forEach(d => {
                let hasQuestionMark = (d.date_raw || '').includes('?');
                let rowData = { data: d.date_raw || '-' };
                let punches = d.punches || [];

                punches.forEach((punch, index) => {
                    rowData[`p${index}`] = punch.time_hhmm;
                    if (punch.time_hhmm.includes('?')) hasQuestionMark = true;
                });

                const row = worksheet.addRow(rowData);
                const isOdd = punches.length % 2 !== 0;
                
                let isNonSeq = false;
                const currDayMatch = d.date_raw.match(/^\s*(\d{1,2})\b/);
                if (currDayMatch) {
                    const currDayNum = parseInt(currDayMatch[1], 10);
                    if (prevDayNum !== null && currDayNum !== prevDayNum + 1 && !(prevDayNum >= 28 && currDayNum === 1)) {
                        isNonSeq = true;
                    }
                    prevDayNum = currDayNum;
                }

                if (isNonSeq) applyRowStyle(row, 'FFF8D7DA', true);
                else if (isOdd || punches.length === 0 || hasQuestionMark) applyRowStyle(row, 'FFFFF3CD', false);
                row.eachCell((cell, colNumber) => { if(colNumber > 1) cell.alignment = { horizontal: 'center' }; });
            }));
        } 
        else if (tipo === 'holerite') {
            const worksheet = workbook.addWorksheet('Holerites');
            const colunasVerbas = new Set();
            dadosEditados.pages?.forEach(p => {
                p.fields?.forEach(f => colunasVerbas.add(f.label));
                p.bases?.forEach(b => colunasVerbas.add(b.label));
            });

            const columns = [
                { header: 'Pág.', key: 'page', width: 8 }, { header: 'Mês', key: 'month', width: 8 }, { header: 'Ano', key: 'year', width: 8 }
            ];
            colunasVerbas.forEach(verba => columns.push({ header: verba, key: verba, width: 18 }));
            worksheet.columns = columns;
            styleHeader(worksheet.getRow(1));

            let prevMonthNum = null;

            dadosEditados.pages?.forEach(p => {
                let hasQuestionMark = (p.month || '').includes('?') || (p.year || '').includes('?');
                let rowData = { page: p.page, month: p.month, year: p.year };
                let fieldsCount = 0;

                p.fields?.forEach(f => { rowData[f.label] = f.value; if ((f.value || '').includes('?')) hasQuestionMark = true; fieldsCount++; });
                p.bases?.forEach(b => { rowData[b.label] = b.value; if ((b.value || '').includes('?')) hasQuestionMark = true; fieldsCount++; });

                const row = worksheet.addRow(rowData);
                let isNonSeq = false;
                const currMonthNum = parseInt(p.month, 10);
                if (!isNaN(currMonthNum)) {
                    if (prevMonthNum !== null && currMonthNum !== prevMonthNum + 1 && !(prevMonthNum === 12 && currMonthNum === 1)) isNonSeq = true;
                    prevMonthNum = currMonthNum;
                }

                if (isNonSeq) applyRowStyle(row, 'FFF8D7DA', true);
                else if (fieldsCount === 0 || hasQuestionMark) applyRowStyle(row, 'FFFFF3CD', false);
            });
        }

        const filename = `extracao_${tipo}_${id}`;
        if (formato === 'csv') {
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=${filename}.csv`);
            await workbook.csv.write(res);
        } else {
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename=${filename}.xlsx`);
            await workbook.xlsx.write(res);
        }
        res.end();
    } catch (error) {
        console.error(`Erro na geração ${formato}:`, error);
        res.status(500).json({ erro: 'Falha ao exportar os dados.' });
    }
});

app.listen(3000, () => console.log('🚀 API RESTful rodando na porta 3000'));