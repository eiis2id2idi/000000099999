// Exemplo de API hospedável no Vexus Host.
// Envie este arquivo em "Hospedar API". Após publicado, acesse: /a/<slug>
module.exports = (req, res) => {
  res.json({
    ok: true,
    metodo: req.method,
    mensagem: 'Sua API está no ar!',
    horario: new Date().toISOString()
  });
};
