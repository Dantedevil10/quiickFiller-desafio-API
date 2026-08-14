// src/worker.js
import { Worker } from 'bullmq';
import { connection } from './queue.js';
import { extrairTextoPDF, estruturarDados } from './extractor.js';

const worker = new Worker('pdf-extraction', async job => {
    console.log(`👷 Iniciando job ${job.id} - Arquivo: ${job.data.originalName}`);
    
    try {
        const textoBruto = await extrairTextoPDF(job.data.filePath);
        const jsonEstruturado = estruturarDados(textoBruto, job.data.tipo);
        
        console.log(`✅ Job ${job.id} concluído!`);
        
        return {
            sucesso: true,
            dados: jsonEstruturado,
            textoBrutoExtraido: textoBruto 
        };

    } catch (error) {
        // Agora mostra a mensagem limpa no console do Back!
        console.error(`❌ Erro no job ${job.id}:`, error.message);
        throw error; // BullMQ salva o error.message na variável 'failedReason'
    }
}, { 
    connection,
    concurrency: 2 
});

console.log('👷 Worker iniciado e escutando a fila...');