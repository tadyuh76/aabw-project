from data_module.config import Settings


def test_settings_reports_missing_keys(monkeypatch):
    monkeypatch.setattr("data_module.config.load_dotenv", lambda **kwargs: None)
    for name in (
        "SUPABASE_SERVICE_ROLE_KEY",
        "TINYFISH_API_KEY",
        "SERPAPI_API_KEY",
        "OPENAI_API_KEY",
    ):
        monkeypatch.delenv(name, raising=False)
    settings = Settings.from_env()
    assert "SUPABASE_SERVICE_ROLE_KEY" in settings.missing_required()
    assert "TINYFISH_API_KEY" in settings.missing_required()
    assert "SERPAPI_API_KEY" in settings.missing_required()
    assert "OPENAI_API_KEY" in settings.missing_required()


def test_settings_reads_env(monkeypatch):
    monkeypatch.setattr("data_module.config.load_dotenv", lambda **kwargs: None)
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co/")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service")
    monkeypatch.setenv("TINYFISH_API_KEY", "tiny")
    monkeypatch.setenv("SERPAPI_API_KEY", "serp")
    monkeypatch.setenv("OPENAI_API_KEY", "openai")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-5.6-luna")
    settings = Settings.from_env(require_all=True)
    assert settings.supabase_url == "https://example.supabase.co"
    assert settings.openai_model == "gpt-5.6-luna"
    assert settings.missing_required() == ()
