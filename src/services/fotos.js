const TAMANHO_MAX = 512;
const QUALIDADE = 0.82;

async function carregarImagem(ficheiro) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(ficheiro, { imageOrientation: 'from-image' });
    } catch {
      /* navegador sem suporte: usa a via clássica */
    }
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onload = () => resolve(leitor.result);
    leitor.onerror = () => reject(new Error('Não foi possível ler o ficheiro escolhido.'));
    leitor.readAsDataURL(ficheiro);
  });
  return new Promise((resolve, reject) => {
    const imagem = new Image();
    imagem.onload = () => resolve(imagem);
    imagem.onerror = () => reject(new Error('O ficheiro escolhido não é uma imagem válida.'));
    imagem.src = dataUrl;
  });
}

export async function reduzirFoto(ficheiro) {
  if (!ficheiro) return null;
  if (!/^image\//.test(ficheiro.type || '')) {
    throw new Error('Escolha um ficheiro de imagem (JPG ou PNG).');
  }
  if (ficheiro.size > 12 * 1024 * 1024) {
    throw new Error('A imagem é demasiado grande. Escolha uma com menos de 12 MB.');
  }

  const imagem = await carregarImagem(ficheiro);
  const escala = Math.min(1, TAMANHO_MAX / Math.max(imagem.width, imagem.height) || 1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(imagem.width * escala));
  canvas.height = Math.max(1, Math.round(imagem.height * escala));
  canvas.getContext('2d').drawImage(imagem, 0, 0, canvas.width, canvas.height);
  if (typeof imagem.close === 'function') imagem.close();

  const dataUrl = canvas.toDataURL('image/jpeg', QUALIDADE);
  if (dataUrl.length > 900000) {
    throw new Error('A imagem continua demasiado grande depois de reduzida. Tente outra.');
  }
  return dataUrl;
}
