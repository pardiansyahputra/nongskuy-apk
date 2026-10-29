package app.nongskuy

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import app.nongskuy.ui.navigation.MainScreen
import app.nongskuy.ui.theme.NONGSKUYTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            NONGSKUYTheme {
                MainScreen()
            }
        }
    }
}