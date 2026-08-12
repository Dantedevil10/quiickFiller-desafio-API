// src/server.js
import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { pdfQueue } from './queue.js';

const app = express();
app.use(cors());
app.use(express.json());

// Configura o Multer para salvar o PDF temporariamente na pasta 'uploads/'
const upload = multer({ dest: 'uploads/' });

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
    const result = job.returnvalue; // Aqui estará o JSON extraído quando terminar

    res.json({ state, result });
});

app.listen(3000, () => console.log('🚀 Servidor rodando na porta 3000'));