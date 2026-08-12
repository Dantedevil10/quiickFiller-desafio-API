// src/worker.js
import { Worker } from 'bullmq';
import { connection } from './queue.js';
import { extrairTextoPDF, estruturarDados } from './extractor.js';

const worker = new Worker('pdf-extraction', async job => {
    console.log(`👷 Iniciando job ${job.id} - Arquivo: ${job.data.originalName}`);
    
    try {
        // 1. Extrai o texto (seja por pdf.js ou Tesseract)
        const textoBruto = await extrairTextoPDF(job.data.filePath);
        
        // 2. Transforma o texto bruto no JSON que vai pra tabela do Angular
        const jsonEstruturado = estruturarDados(textoBruto, job.data.tipo);
        
        console.log(`✅ Job ${job.id} concluído!`);
        
        // O que for retornado aqui vai automaticamente para o 'job.returnvalue' (que o servidor consulta na rota de status)
        return {
            sucesso: true,
            dados: jsonEstruturado,
            textoBrutoExtraido: textoBruto // Opcional, para debug
        };

    } catch (error) {
        console.error(`❌ Erro no job ${job.id}:`, error);
        throw error; // Marca o job como falho no BullMQ
    }
}, { 
    connection,
    concurrency: 2 // Só processa 2 PDFs por vez para não travar o servidor com o Tesseract!
});

console.log('👷 Worker iniciado e escutando a fila...');