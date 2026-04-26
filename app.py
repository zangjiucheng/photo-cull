import os

from server import create_app


app = create_app()


if __name__ == "__main__":
    host = os.getenv("FLASK_HOST", "0.0.0.0")
    port = int(os.getenv("FLASK_PORT", "5050"))
    app.run(debug=os.getenv("FLASK_DEBUG", "1") == "1", host=host, port=port)
