document.addEventListener('DOMContentLoaded', () => {
    const messageForm = document.getElementById('messageForm');
    const messageText = document.getElementById('messageText');
    const messagesContainer = document.getElementById('messagesContainer');

    const API_URL = '/api/messages'; 

    async function fetchMessages() {
        try {
            const response = await fetch(API_URL);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const messages = await response.json();
            displayMessages(messages);
        } catch (error) {
            console.error('Failed to fetch messages:', error);
            messagesContainer.innerHTML = '<p>Error loading messages. Is the backend running?</p>';
        }
    }

    function displayMessages(messages) {
        messagesContainer.innerHTML = ''; 

        if (!messages || messages.length === 0) {
            messagesContainer.innerHTML = '<p>No messages yet. Be the first to post!</p>';
            return;
        }

        messages.forEach(message => {
            const messageElement = document.createElement('div');
            messageElement.classList.add('message-item');

            const content = document.createElement('p');
            content.textContent = message.content; 

            const timestamp = document.createElement('small');
            
            timestamp.textContent = message.created_at ? new Date(message.created_at).toLocaleString() : 'Just now';

            messageElement.appendChild(content);
            messageElement.appendChild(timestamp);
            messagesContainer.appendChild(messageElement);
        });
    }

    
    messageForm.addEventListener('submit', async (event) => {
        event.preventDefault(); 

        const messageContent = messageText.value.trim();
        if (!messageContent) {
            alert('Please enter a message.');
            return;
        }

        try {
            const response = await fetch(API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ content: messageContent }), 
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }


            messageText.value = ''; 
            fetchMessages(); 
        } catch (error) {
            console.error('Failed to post message:', error);
            alert('Failed to post message. Check console for details.');
        }
    });

    fetchMessages();
});