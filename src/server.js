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

// NOVA ROTA: Recebe o JSON complexo e gera o Excel
app.post('/api/gerar-excel', async (req, res) => {
    const dadosEditados = req.body.dados;
    const tipo = req.body.tipo;

    if (!dadosEditados || !dadosEditados.pages) {
        return res.status(400).json({ erro: 'Dados inválidos enviados.' });
    }

    try {
        const workbook = new ExcelJS.Workbook();

        // ==========================================
        // LÓGICA PARA CARTÃO DE PONTO
        // ==========================================
        if (tipo === 'ponto') {
            const worksheet = workbook.addWorksheet('Extracao_Ponto');

            // Configura as colunas
            worksheet.columns = [
                { header: 'Página', key: 'page', width: 10 },
                { header: 'Data', key: 'data', width: 15 },
                { header: 'Tipo', key: 'kind', width: 15 },
                { header: 'Horário Bruto', key: 'raw', width: 15 },
                { header: 'Horário Corrigido (Final)', key: 'final', width: 25 }
            ];

            worksheet.getRow(1).font = { bold: true };

            // Desestrutura o JSON complexo para montar as linhas
            dadosEditados.pages.forEach(p => {
                if (p.days) {
                    p.days.forEach(d => {
                        if (!d.punches || d.punches.length === 0) {
                            worksheet.addRow({ page: p.page, data: d.date_raw, kind: 'Sem Registro', raw: '-', final: '-' });
                        } else {
                            d.punches.forEach(punch => {
                                worksheet.addRow({
                                    page: p.page,
                                    data: d.date_raw,
                                    kind: punch.kind === 'IN' ? 'Entrada' : 'Saída',
                                    raw: punch.time_raw,
                                    final: punch.time_hhmm // Valor editado pelo usuário!
                                });
                            });
                        }
                    });
                }
            });
        } 
        // ==========================================
        // LÓGICA PARA HOLERITE / FICHA FINANCEIRA
        // ==========================================
        else if (tipo === 'holerite') {
            const worksheet = workbook.addWorksheet('Extracao_Holerite');

            // Configura as colunas
            worksheet.columns = [
                { header: 'Competência', key: 'comp', width: 15 },
                { header: 'Código', key: 'code', width: 10 },
                { header: 'Descrição', key: 'label', width: 40 },
                { header: 'Referência', key: 'ref', width: 15 },
                { header: 'Valor (R$)', key: 'val', width: 15 }
            ];

            worksheet.getRow(1).font = { bold: true };

            dadosEditados.pages.forEach(p => {
                const competencia = `${p.month || '--'}/${p.year || '----'}`;

                // 1. Lança as Verbas
                if (p.fields) {
                    p.fields.forEach(f => {
                        worksheet.addRow({
                            comp: competencia,
                            code: f.code,
                            label: f.label,
                            ref: f.reference,
                            val: f.value
                        });
                    });
                }

                // 2. Lança as Bases e Totais logo abaixo das verbas
                if (p.bases && p.bases.length > 0) {
                    // Adiciona uma linha em branco para separar visualmente
                    worksheet.addRow({}); 
                    
                    p.bases.forEach(b => {
                        const row = worksheet.addRow({
                            comp: competencia,
                            code: '-',
                            label: b.label,
                            ref: '-',
                            val: b.value
                        });
                        // Destaca a linha de Base/Total em Negrito
                        row.font = { bold: true };
                    });

                    // Adiciona mais uma linha em branco para separar meses/páginas diferentes
                    worksheet.addRow({});
                }
            });
        }

        // Retorna o arquivo como um stream binário para download
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=extracao_${tipo}.xlsx`);

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error('Erro ao gerar Excel:', error);
        res.status(500).json({ erro: 'Falha ao gerar a planilha.' });
    }
});

app.listen(3000, () => console.log('🚀 Servidor rodando na porta 3000'));